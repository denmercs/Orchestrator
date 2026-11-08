import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { factoryProjection, factoryStatus } from "./factory-status";
import { sliceDir } from "./factory-layout";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const put = (file: string, text: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};

// A factory with one mission and two slices: s1 is building with a live agent and no proof, s2 is in test with a dead one and proof written.
function setup() {
  const root = mkdtempSync(join(tmpdir(), "status-"));
  roots.push(root);
  const home = join(root, ".harness", "factory");
  put(join(home, "project.md"), "Ship the widget shop.\n");
  put(join(home, "culture.md"), "SECRET-CULTURE-TEXT\n");
  put(join(home, "missions", "m1", "mission.md"), "Outcome: checkout works end to end.\n");
  put(join(sliceDir(root, "m1", "s1"), "spec.md"), "Add the cart.\n");
  put(join(sliceDir(root, "m1", "s1"), "state.md"), "---\nphase: build\nrun: on\nattempt: 2\nagent: live-1\nworktree: /w/s1\n---\n");
  put(join(sliceDir(root, "m1", "s2"), "spec.md"), "Add payment.\n");
  put(join(sliceDir(root, "m1", "s2"), "state.md"), "---\nphase: test\nrun: off\nready: review\nattempt: 1\nagent: dead-2\n---\n");
  put(join(sliceDir(root, "m1", "s2"), "proof.md"), "All checks pass.\n");
  return root;
}

const alive = async (agent: string) => agent === "live-1";

// Every file under `root` with its bytes, to compare before and after.
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? Object.entries(snapshot(path)) : [[path, `${statSync(path).size}:${readFileSync(path, "utf8")}`]];
    }),
  );
}

test("the projection holds the project, each outcome and per slice phase, run, ready, attempt, proof and agent", async () => {
  const projection = await factoryProjection(setup(), alive);
  assert.match(projection ?? "", /Ship the widget shop\./);
  assert.match(projection ?? "", /checkout works end to end/);
  assert.match(projection ?? "", /s1.*phase build.*run on.*attempt 2.*proof no.*agent alive/);
  assert.match(projection ?? "", /s2.*phase test.*run off.*ready review.*attempt 1.*proof yes.*agent dead/);
});

test("the projection is a summary: no spec text, no culture, no frontmatter keys", async () => {
  const projection = (await factoryProjection(setup(), alive)) ?? "";
  assert.doesNotMatch(projection, /Add the cart|SECRET-CULTURE|worktree|---|attempt:/);
});

test("a slice with no agent id reads as agent none", async () => {
  const root = setup();
  put(join(sliceDir(root, "m1", "s3"), "state.md"), "---\nphase: spec\n---\n");
  assert.match((await factoryProjection(root, alive)) ?? "", /s3.*agent none/);
});

test("no missions and no project is no factory", async () => {
  const root = mkdtempSync(join(tmpdir(), "status-"));
  roots.push(root);
  assert.equal(await factoryProjection(root, alive), null);
  assert.equal(await factoryStatus(root, { ask: async () => ({ text: "x", costUsd: 0 }), unavailable: async () => null, alive }), null);
});

test("the answer is the one-shot's reply to the projection, and the factory tree is untouched", async () => {
  const root = setup();
  const before = snapshot(root);
  const calls: { system: string; prompt: string }[] = [];
  const result = await factoryStatus(root, {
    ask: async (system, prompt) => {
      calls.push({ system, prompt });
      return { text: "  Two slices; s1 is building.  ", costUsd: 0 };
    },
    unavailable: async () => null,
    alive,
  });
  assert.deepEqual(result, { answer: "Two slices; s1 is building." });
  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /three short spoken sentences/);
  assert.match(calls[0].prompt, /s1.*phase build/);
  assert.deepEqual(snapshot(root), before);
});

test("when the one-shot is unavailable the reason comes back and ask is never called", async () => {
  let asked = 0;
  const result = await factoryStatus(setup(), {
    ask: async () => {
      asked += 1;
      return { text: "x", costUsd: 0 };
    },
    unavailable: async () => "Claude Code is not signed in.",
    alive,
  });
  assert.deepEqual(result, { unavailable: "Claude Code is not signed in." });
  assert.equal(asked, 0);
});

test("an ask that throws is treated as unavailable, with its message", async () => {
  const result = await factoryStatus(setup(), {
    ask: async () => {
      throw new Error("endpoint answered 500");
    },
    unavailable: async () => null,
    alive,
  });
  assert.deepEqual(result, { unavailable: "endpoint answered 500" });
});
