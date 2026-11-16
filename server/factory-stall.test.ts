import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { type FactorySlice, parseSliceState } from "../shared/factory";
import { sliceDir, writeSliceState } from "./factory-layout";
import {
  BUILD_DONE,
  STALL_MINUTES,
  buildDoneSignal,
  confirmDead,
  finishBuildSeat,
  sliceAgentStale,
  stallTimedOut,
} from "./factory-phases";
import type { TickPaseo } from "./factory-tick";
import { writeFrontmatter } from "./harness-layout";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const slice = (extra: Record<string, string> = {}) => ({
  id: "s1",
  mission: "m1",
  state: parseSliceState({ phase: "build", run: "on", worktree: "/w", story: "/w/.harness/story.md", ...extra }),
  spec: "Do it.",
  design: "",
  proof: "",
});

const agents: TickPaseo["agents"] = {
  ref: (id: string) => ({
    refresh: async () => ({ agent: { id, status: "idle" as const, labels: { kind: "factory-seat", seat: "builder", "factory-slice": "scout-1" } } }),
  }),
  create: async () => ({ id: "x" }),
};

test("A: an idle agent on another slice is stale", async () => {
  assert.equal(await sliceAgentStale(slice({ agent: "a1" }), "builder", "a1", { status: "idle" }, agents), true);
});

test("A: a running builder for this slice is not stale", async () => {
  const live: TickPaseo["agents"] = {
    ref: () => ({
      refresh: async () => ({ agent: { status: "running", labels: { kind: "factory-seat", seat: "builder", "factory-slice": "s1" } } }),
    }),
    create: async () => ({ id: "x" }),
  };
  assert.equal(await sliceAgentStale(slice({ agent: "a1" }), "builder", "a1", { status: "running" }, live), false);
});

test("A: a missing agent is stale", async () => {
  const gone: TickPaseo["agents"] = {
    ref: () => ({ refresh: async () => null }),
    list: async () => ({ entries: [] }),
    create: async () => ({ id: "x" }),
  };
  assert.equal(await confirmDead(gone, "gone", null), true);
  assert.equal(await sliceAgentStale(slice(), "builder", "gone", null, gone), true);
});

test("B: build-done in proof finishes build and moves to test", async () => {
  const root = mkdtempSync(join(tmpdir(), "stall-"));
  roots.push(root);
  const worktree = join(root, "wt");
  mkdirSync(join(worktree, ".harness"), { recursive: true });
  const story = join(worktree, ".harness", "story.md");
  writeFileSync(story, "---\nstep: plan\nstatus: planning\n---\n");
  writeFileSync(join(worktree, ".harness", "state.md"), "# S\n\n## Status\nplan-running\n");
  execFileSync("git", ["init"], { cwd: worktree });
  execFileSync("git", ["config", "user.email", "t@test"], { cwd: worktree });
  execFileSync("git", ["config", "user.name", "t"], { cwd: worktree });
  writeFileSync(join(worktree, "code.ts"), "x");
  execFileSync("git", ["add", "code.ts"], { cwd: worktree });
  execFileSync("git", ["commit", "-m", "start"], { cwd: worktree });
  writeFileSync(join(worktree, "code.ts"), "xy");
  putSlice(root, worktree, story);
  writeFileSync(join(sliceDir(root, "m1", "s1"), "proof.md"), `${BUILD_DONE}\n`);
  const commits: string[] = [];
  const result = await finishBuildSeat(
    root,
    {
      id: "s1",
      mission: "m1",
      state: parseSliceState({
        phase: "build",
        run: "on",
        worktree,
        story,
        agent: "b-1",
      }),
      spec: "x",
      design: "",
      proof: BUILD_DONE,
    },
    { agents: { ref: () => ({ refresh: async () => null }), create: async () => ({ id: "x" }) }, commit: async () => { commits.push("yes"); return true; } },
    { title: "s1" },
    { status: "idle", attentionReason: "finished" },
  );
  assert.deepEqual(result, { kind: "advanced", slice: "s1", phase: "test" });
  assert.equal(commits.length, 1);
  assert.equal(readFrontmatter(story, "step"), "implement");
  assert.equal(readFrontmatter(join(sliceDir(root, "m1", "s1"), "state.md"), "phase"), "test");
  assert.match(readFileSync(join(worktree, ".harness", "state.md"), "utf8"), /implement-done/);
});

test("B: the agent's last message can signal build done", () => {
  assert.equal(buildDoneSignal(slice(), { lastMessage: "The build is done." }), true);
});

test("D: stall timeout fires after ten idle minutes", () => {
  const now = Date.now();
  const stalled: FactorySlice = {
    ...slice(),
    state: parseSliceState({
      phase: "build",
      run: "on",
      worktree: "/w",
      story: "/w/.harness/story.md",
      agent: "a1",
      idle_since: new Date(now - STALL_MINUTES * 60_000 - 1).toISOString(),
    }),
  };
  assert.equal(stalled.state.idle_since.length > 0, true);
  assert.equal(stallTimedOut(stalled, () => now), true);
  const fresh = { ...slice(), state: parseSliceState({ phase: "build", run: "on", idle_since: new Date(now - 60_000).toISOString() }) };
  assert.equal(stallTimedOut(fresh, () => now), false);
});

function putSlice(root: string, worktree: string, story: string) {
  const dir = sliceDir(root, "m1", "s1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.md"), `---\nphase: build\nrun: on\nworktree: ${worktree}\nstory: ${story}\nagent: b-1\n---\n`);
  writeFileSync(join(root, ".harness", "factory", "project.md"), "p\n");
  mkdirSync(join(root, ".harness", "factory", "missions", "m1", "slices", "s1"), { recursive: true });
}

function readFrontmatter(file: string, key: string) {
  const text = readFileSync(file, "utf8");
  return text.match(new RegExp(`^${key}: (.*)$`, "m"))?.[1];
}