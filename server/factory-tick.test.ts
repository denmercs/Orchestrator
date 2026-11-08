import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { namedStories, sliceDir, storyKey } from "./factory-layout";
import { runFactoryTick, type TickPaseo } from "./factory-tick";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const put = (file: string, text: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};

// A factory with one slice in `build`; `state` is its state.md frontmatter beyond the worktree.
function setup(state: string, run = "on") {
  const root = mkdtempSync(join(tmpdir(), "tick-"));
  roots.push(root);
  const worktree = join(root, "wt");
  mkdirSync(worktree);
  const home = join(root, ".harness", "factory");
  put(join(home, "project.md"), "Ship the thing.\n");
  put(join(home, "missions", "m1", "mission.md"), "Outcome: one slice lands.\n");
  const dir = sliceDir(root, "m1", "s1");
  put(join(dir, "spec.md"), "Add the widget.\n");
  put(join(dir, "state.md"), `---\nphase: build\nrun: ${run}\nworktree: ${worktree}\n${state}\n---\n`);
  return { root, worktree, stateFile: join(dir, "state.md") };
}

function fakePaseo(known: Record<string, { status: string; archivedAt?: string | null }> = {}) {
  const created: { cwd: string; prompt: string }[] = [];
  const paseo: TickPaseo = {
    agents: {
      ref: (id) => ({ refresh: async () => (known[id] ? { agent: known[id] } : null) }),
      create: async (request) => {
        created.push({ cwd: request.cwd, prompt: request.prompt });
        await new Promise((resolve) => setImmediate(resolve));
        const id = `new-${created.length}`;
        known[id] = { status: "idle" };
        return { id };
      },
    },
  };
  return { paseo, created };
}

test("a slice without run: on stays idle", async () => {
  const { root } = setup("agent: dead-1", "off");
  const { paseo, created } = fakePaseo();
  assert.deepEqual(await runFactoryTick(root, paseo), { kind: "idle" });
  assert.equal(created.length, 0);
});

test("a missing factory is an idle tick", async () => {
  const root = mkdtempSync(join(tmpdir(), "tick-"));
  roots.push(root);
  assert.deepEqual(await runFactoryTick(root, fakePaseo().paseo), { kind: "idle" });
});

test("a build slice whose agent is dead gets one builder in its worktree, with the spec and refocus", async () => {
  const { root, worktree, stateFile } = setup("agent: dead-1\nattempt: 1");
  const { paseo, created } = fakePaseo({ "dead-1": { status: "error" } });
  const result = await runFactoryTick(root, paseo);
  assert.deepEqual(result, { kind: "restarted", slice: "s1", agent: "new-1" });
  assert.equal(created.length, 1);
  assert.equal(created[0].cwd, worktree);
  assert.match(created[0].prompt, /Add the widget\./);
  assert.match(created[0].prompt, /Outcome: one slice lands\./);
  assert.match(created[0].prompt, /Ship the thing\./);
  assert.match(created[0].prompt, /still serve/);
  const state = readFileSync(stateFile, "utf8");
  assert.match(state, /agent: new-1/);
  assert.match(state, /attempt: 2/);
  assert.match(state, /seat: builder/);
});

test("a live agent is left alone, whatever it is doing", async () => {
  for (const status of ["idle", "running", "initializing"]) {
    const { root } = setup("agent: live-1");
    const { paseo, created } = fakePaseo({ "live-1": { status } });
    assert.deepEqual(await runFactoryTick(root, paseo), { kind: "alive", slice: "s1", agent: "live-1" });
    assert.equal(created.length, 0);
  }
});

test("an archived or missing agent is replaced", async () => {
  const gone: Record<string, { status: string; archivedAt?: string }>[] = [{ "a-1": { status: "idle", archivedAt: "2026-11-01" } }, { other: { status: "idle" } }];
  for (const known of gone) {
    const { root } = setup("agent: a-1");
    const { paseo, created } = fakePaseo(known);
    assert.equal((await runFactoryTick(root, paseo)).kind, "restarted");
    assert.equal(created.length, 1);
  }
});

test("two ticks at once give a dead builder exactly one replacement", async () => {
  const { root } = setup("agent: dead-1");
  const { paseo, created } = fakePaseo({ "dead-1": { status: "closed" } });
  await Promise.all([runFactoryTick(root, paseo), runFactoryTick(root, paseo)]);
  await runFactoryTick(root, paseo);
  assert.equal(created.length, 1);
});

test("the tick leaves a story the loop's live session still supervises", async () => {
  const { root } = setup("agent: dead-1\nstory: STORY");
  const story = join(root, "story.md");
  put(story, "---\nstatus: implementing\nagent: loop-1\n---\n");
  const stateFile = join(sliceDir(root, "m1", "s1"), "state.md");
  writeFileSync(stateFile, readFileSync(stateFile, "utf8").replace("STORY", story));
  const { paseo, created } = fakePaseo({ "dead-1": { status: "error" }, "loop-1": { status: "running" } });
  assert.equal((await runFactoryTick(root, paseo)).kind, "waiting");
  assert.equal(created.length, 0);
});

test("namedStories lists the story files slices name, so the loop skips them", () => {
  const { root } = setup("story: /x/y/story.md");
  assert.deepEqual([...namedStories(root)], ["/x/y/story.md"]);
});

test("namedStories matches relative and symlinked story paths under any root", () => {
  const { root } = setup("story: stories/story.md");
  const real = join(root, "stories", "story.md");
  put(real, "---\nstatus: todo\n---\n");
  const link = join(mkdtempSync(join(tmpdir(), "link-")), "story.md");
  symlinkSync(real, link);
  const named = namedStories(root);
  assert.ok(named.has(storyKey(real)));
  assert.ok(named.has(storyKey(link)));
  assert.ok(named.has(storyKey("stories/story.md", root)));
  assert.ok(!named.has(storyKey("stories/story.md", tmpdir())));
});
