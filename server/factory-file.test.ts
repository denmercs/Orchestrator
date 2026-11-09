import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileInitiative, fileSlice } from "./factory-file";
import { readFactory, sliceDir } from "./factory-layout";
import type { ManagerPaseo } from "./factory-manager";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "file-slice-"));
  roots.push(root);
  return root;
};

// A fake Paseo whose manager creates once and records every steer.
function fakePaseo() {
  const sent: string[] = [];
  const paseo: ManagerPaseo = {
    agents: {
      ref: () => ({
        send: async (text) => {
          sent.push(text);
        },
        refresh: async () => ({ agent: { status: "idle" } }),
      }),
      create: async () => ({ id: "manager-1" }),
    },
  };
  return { paseo, sent };
}

test("fileSlice writes an inbox slice with the title and link as its spec and no run", async () => {
  const root = tempRoot();
  const { paseo, sent } = fakePaseo();

  const ids = await fileSlice(root, { title: "Add dark mode", link: "https://jira.example/T-1" }, { paseo });

  assert.deepEqual(ids, ["add-dark-mode"]);
  const slice = readFactory(root).missions.find((mission) => mission.id === "inbox")?.slices[0];
  assert.match(slice?.spec ?? "", /Add dark mode/);
  assert.match(slice?.spec ?? "", /https:\/\/jira\.example\/T-1/);
  assert.equal(slice?.state.run, false);
  assert.equal(slice?.state.story, "");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /add-dark-mode/);
});

test("fileSlice names the story file in state.md", async () => {
  const root = tempRoot();
  const { paseo } = fakePaseo();

  await fileSlice(root, { title: "Story one", story: "/repo/stories/01.md" }, { paseo });

  const state = readFileSync(join(sliceDir(root, "inbox", "story-one"), "state.md"), "utf8");
  assert.match(state, /^story: \/repo\/stories\/01\.md$/m);
  assert.doesNotMatch(state, /^run:/m);
});

test("fileSlice suffixes the id when a slice of that name exists", async () => {
  const root = tempRoot();
  const { paseo } = fakePaseo();

  const first = await fileSlice(root, { title: "Same title" }, { paseo });
  const second = await fileSlice(root, { title: "Same title" }, { paseo });
  const third = await fileSlice(root, { title: "Same title" }, { paseo });

  assert.deepEqual([first, second, third], [["same-title"], ["same-title-2"], ["same-title-3"]]);
  assert.ok(existsSync(join(sliceDir(root, "inbox", "same-title-3"), "spec.md")));
});

test("fileSlice creates the inbox mission with an outcome when the factory is missing", async () => {
  const root = tempRoot();
  const { paseo } = fakePaseo();

  await fileSlice(root, { title: "First" }, { paseo });

  const inbox = readFactory(root).missions.find((mission) => mission.id === "inbox");
  assert.ok(inbox && inbox.outcome.length > 0);
});

function writeInitiative(repo: string) {
  const dir = join(repo, ".harness", "initiatives", "demo");
  const story = (phase: string, file: string, meta: string) => {
    mkdirSync(join(dir, "phases", phase, "stories"), { recursive: true });
    writeFileSync(join(dir, "phases", phase, "stories", file), `---\n${meta}\n---\nBody\n`, "utf8");
    return join(dir, "phases", phase, "stories", file);
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "initiative.md"), "---\ntitle: Demo\n---\n", "utf8");
  story("1-done", "01-old.md", "id: old\ntitle: Old work\nstatus: merged");
  const running = story("2-live", "01-running.md", "id: running\ntitle: Running work\nstep: implement");
  const named = story("2-live", "02-named.md", "id: named\ntitle: Named work");
  const first = story("2-live", "03-first.md", "id: first\ntitle: First work\njira_url: https://jira.example/T-3");
  const second = story("2-live", "04-second.md", "id: second\ntitle: Second work\nstatus: todo");
  return { running, named, first, second };
}

test("fileInitiative files the remaining todo stories of the active phase in order with one steer", async () => {
  const root = tempRoot();
  const repo = tempRoot();
  const stories = writeInitiative(repo);
  const { paseo, sent } = fakePaseo();
  await fileSlice(root, { title: "Earlier", story: stories.named }, { paseo });
  sent.length = 0;

  const ids = await fileInitiative(root, { repo, initiative: "demo" }, { paseo });

  assert.deepEqual(ids, ["demo-first", "demo-second"]);
  const inbox = readFactory(root).missions.find((mission) => mission.id === "inbox");
  const filed = inbox?.slices.filter((slice) => ids.includes(slice.id)) ?? [];
  assert.deepEqual(filed.map((slice) => slice.state.story), [stories.first, stories.second]);
  assert.match(filed[0].spec, /First work/);
  assert.match(filed[0].spec, /https:\/\/jira\.example\/T-3/);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /demo-first, demo-second/);

  // Filing again finds every story named already, so nothing new is written or sent.
  assert.deepEqual(await fileInitiative(root, { repo, initiative: "demo" }, { paseo }), []);
  assert.equal(sent.length, 1);
});
