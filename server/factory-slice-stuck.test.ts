import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { PluginHookAgent, PluginTurnOutcome } from "@getpaseo/plugin/server";
import { DEFAULT_LOOP_CONFIG } from "../shared/initiative-loop";
import { frontmatter, writeFrontmatter } from "./harness-layout";
import { STUCK_CLEAR, nudgePrompt } from "./story-steps";
import { factorySeatTurnEnded } from "./factory-slice-stuck";

const storyMeta = (file: string) => frontmatter(readFileSync(file, "utf8"));
const ended = (id: string, outcome: Record<string, unknown>, timeline: unknown[] = []) =>
  ({ agent: { id }, outcome, timeline }) as unknown as { agent: PluginHookAgent; outcome: PluginTurnOutcome; timeline?: unknown[] };

// A Paseo handle with just the agents the factory seat check reads and nudges: their labels, and what is sent to them.
function fakePaseo(live: { id: string; labels: Record<string, string> }[]) {
  const sent: { id: string; text: string }[] = [];
  const api = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => {
          const found = live.find((agent) => agent.id === id);
          return found ? { agent: { id, labels: { ...found.labels } } } : null;
        },
        send: async (text: string) => {
          sent.push({ id, text });
        },
      }),
    },
  } as unknown as PluginHandlerContext["paseo"];
  return { api, sent };
}

const failingRun = {
  type: "tool_call",
  status: "completed",
  detail: { type: "shell", command: ".harness/bin/brief npm test", output: "brief: exit 1\nnot ok 1 - parses a turn\n# tests 5\n# fail 1" },
};

// A factory slice's build agent: the story and the slice's state.md name it, and its labels carry the slice, not an initiative.
function sliceFixture(agent = "a1") {
  const root = mkdtempSync(join(tmpdir(), "slice-repo-"));
  const worktree = join(root, "wt");
  mkdirSync(join(worktree, ".harness"), { recursive: true });
  const story = join(root, "story.md");
  writeFileSync(
    story,
    `---\nid: S1\ntitle: Demo story\nstatus: implementing\nstep: implement\nround: 1\nworktree: ${worktree}\nagent: ${agent}\n---\n\n## Goal\n\nShip it.\n`,
    "utf8",
  );
  writeFileSync(join(worktree, ".harness", "state.md"), "# S1 — Demo story\n\n## Status\nimplement-running\n", "utf8");
  const home = join(root, ".harness", "factory");
  const dir = join(home, "missions", "m1", "slices", "s1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, "project.md"), "Ship.\n");
  writeFileSync(join(home, "missions", "m1", "mission.md"), "Land one slice.\n");
  writeFileSync(join(dir, "spec.md"), "Build it.\n");
  const state = join(dir, "state.md");
  writeFileSync(state, `---\nphase: build\nrun: on\nseat: builder\nagent: ${agent}\nworktree: ${worktree}\nstory: ${story}\n---\n`, "utf8");
  const labels = {
    kind: "factory-seat",
    seat: "builder",
    "factory-slice": "s1",
    "factory-mission": "m1",
    "loop-step": "implement",
    "loop-round": "1",
  };
  return { root, worktree, story, state, labels };
}

// The seat check with stuckTurns 3, finding the factory at `root`, recording the manager steers instead of sending them.
// `initiative.onTurnEnded(api, event)` is the hook index.server.ts calls first on every turn end.
function sliceStuckLoop(root: string) {
  const steers: string[] = [];
  const initiative = {
    onTurnEnded: (api: PluginHandlerContext["paseo"], event: ReturnType<typeof ended>) =>
      factorySeatTurnEnded(api, event, {
        readFactoryRoot: async () => root,
        readConfig: async () => ({ ...DEFAULT_LOOP_CONFIG, stuckTurns: 3 }),
        steer: async (_root, line) => {
          steers.push(line);
        },
      }),
  };
  return { initiative, steers };
}
const harnessEdit = { type: "tool_call", status: "completed", detail: { type: "edit", filePath: "/w/.harness/state.md", newString: "x" } };
const codeEdit = { type: "tool_call", status: "completed", detail: { type: "edit", filePath: "src/a.ts", newString: "x" } };
const testEdit = { type: "tool_call", status: "completed", detail: { type: "edit", filePath: "src/a.test.ts", newString: "x" } };
const passingRun = { type: "tool_call", status: "completed", detail: { type: "shell", command: ".harness/bin/brief npm test", output: "# tests 5\n# pass 5\n# fail 0" } };
const sliceTurn = (initiative: ReturnType<typeof sliceStuckLoop>["initiative"], api: PluginHandlerContext["paseo"], ...items: unknown[]) =>
  initiative.onTurnEnded(api, ended("a1", { kind: "completed" }, [{ type: "user_message" }, ...items]));

test("a slice seat that edits only .harness files for stuckTurns turns is nudged, then blocked with one manager steer", async () => {
  const { root, worktree, story, state, labels } = sliceFixture("a1");
  const { api, sent } = fakePaseo([{ id: "a1", labels: { ...labels, seat: "reviewer", "loop-step": "review" } }]);
  const { initiative, steers } = sliceStuckLoop(root);
  writeFileSync(join(worktree, ".harness", "state.md"), "# S1\n\n## Status\nreview-running\n", "utf8");

  for (let turn = 0; turn < 2; turn++) await sliceTurn(initiative, api, harnessEdit);
  assert.deepEqual(sent, []);
  assert.equal(storyMeta(story).ceremony_turns, "2");

  await sliceTurn(initiative, api, harnessEdit);
  assert.deepEqual(sent, [{ id: "a1", text: nudgePrompt("You look stuck: 3 turns in a row edited only .harness files.") }]);
  assert.equal(storyMeta(story).stuck_nudged, "1");
  assert.equal(storyMeta(state).ready, undefined);
  assert.deepEqual(steers, []);

  await sliceTurn(initiative, api, harnessEdit);
  assert.equal(storyMeta(state).ready, "blocked");
  assert.deepEqual(steers, ["Slice s1 is blocked: stuck: 4 turns in a row edited only .harness files. Clear `ready` in its state.md once it is sorted out."]);
  assert.equal(sent.length, 1, "the block sends the seat nothing more");
  const meta = storyMeta(story);
  assert.deepEqual([meta.ceremony_turns, meta.stuck_nudged], [undefined, undefined], "a reopen starts the counters clean");

  await sliceTurn(initiative, api, harnessEdit);
  assert.equal(steers.length, 1, "a blocked slice is not blocked again");
});

test("a slice seat's turn that edits product code, or turns a failing test green, is not stuck", async () => {
  const { root, story, state, labels } = sliceFixture("a1");
  const { api, sent } = fakePaseo([{ id: "a1", labels }]);
  const { initiative, steers } = sliceStuckLoop(root);

  writeFrontmatter(story, { ceremony_turns: 2 });
  await sliceTurn(initiative, api, harnessEdit, codeEdit);
  assert.equal(storyMeta(story).ceremony_turns, undefined);

  writeFrontmatter(story, { fail_tests: '["parses a turn"]', fail_runs: 2, fail_edits: "tests" });
  await sliceTurn(initiative, api, harnessEdit, passingRun);
  const meta = storyMeta(story);
  assert.deepEqual([meta.fail_runs, meta.fail_edits, meta.ceremony_turns], [undefined, undefined, "1"]);

  writeFrontmatter(story, { fail_tests: '["parses a turn"]', fail_runs: 2, fail_edits: "tests" });
  await sliceTurn(initiative, api, codeEdit, failingRun);
  assert.equal(storyMeta(story).fail_edits, "code");
  assert.equal(storyMeta(state).ready, undefined);
  assert.deepEqual(steers, []);
  assert.equal(sent.length, 1, "only the plain failing streak got a nudge, and no block");
});

test("a slice seat that only edits tests while one test keeps failing is blocked as checks instead of a fix", async () => {
  const { root, story, state, labels } = sliceFixture("a1");
  const { api, sent } = fakePaseo([{ id: "a1", labels }]);
  const { initiative, steers } = sliceStuckLoop(root);

  await sliceTurn(initiative, api, testEdit, failingRun);
  await sliceTurn(initiative, api, testEdit, failingRun);
  await sliceTurn(initiative, api, testEdit, failingRun);
  assert.equal(
    sent[0].text,
    nudgePrompt("You look stuck: parses a turn failed 3 test runs in a row, and every turn edited only tests or .harness files, not the code under test."),
  );
  await sliceTurn(initiative, api, testEdit, failingRun);
  assert.equal(storyMeta(state).ready, "blocked");
  assert.equal(steers.length, 1);
  assert.match(steers[0], /^Slice s1 is blocked: stuck: parses a turn failed 3 test runs in a row, and every turn edited only tests/);
  assert.equal(storyMeta(story).fail_runs, undefined);
});

test("a slice seat that is not on a loop step (QA, Ship) gets the ceremony check, and a Plan step is exempt", async () => {
  const { root, story, state, labels } = sliceFixture("a1");
  const { api, sent } = fakePaseo([{ id: "a1", labels: { kind: "factory-seat", seat: "qa", slice: "s1", mission: "m1" } }]);
  const { initiative, steers } = sliceStuckLoop(root);
  writeFrontmatter(state, { phase: "test", seat: "qa" });
  writeFrontmatter(story, { ceremony_turns: 2, stuck_nudged: 1 });

  await sliceTurn(initiative, api, harnessEdit);
  assert.equal(storyMeta(state).ready, "blocked");
  assert.match(steers[0], /^Slice s1 is blocked: stuck: 3 turns in a row edited only \.harness files\./);

  writeFrontmatter(state, { ready: null, phase: "build", seat: "builder" });
  writeFrontmatter(story, { ceremony_turns: 5, stuck_nudged: 1 });
  const planner = fakePaseo([{ id: "a1", labels: { ...labels, "loop-step": "plan" } }]);
  await sliceTurn(initiative, planner.api, harnessEdit);
  assert.equal(storyMeta(state).ready, undefined);
  assert.equal(steers.length, 1);
  assert.deepEqual(sent, []);
});

test("a turn from a slice agent the slice no longer names, or a failed turn, leaves the story alone", async () => {
  const { root, story, labels } = sliceFixture("a2");
  const { api } = fakePaseo([{ id: "a1", labels }]);
  const { initiative, steers } = sliceStuckLoop(root);
  writeFrontmatter(story, { ceremony_turns: 2 });

  await sliceTurn(initiative, api, harnessEdit);
  await initiative.onTurnEnded(api, ended("a1", { kind: "failed", error: { message: "x" } }, [{ type: "user_message" }, harnessEdit]));
  assert.equal(storyMeta(story).ceremony_turns, "2");
  assert.deepEqual(steers, []);
});

test("ceremony speaks before idle on Implement, and a slice seat whose step is done is neither nudged nor blocked", async () => {
  const { root, worktree, story, state, labels } = sliceFixture("a1");
  const { api, sent } = fakePaseo([{ id: "a1", labels }]);
  const { initiative, steers } = sliceStuckLoop(root);

  writeFrontmatter(story, { ceremony_turns: 2, idle_turns: 2 });
  await sliceTurn(initiative, api, harnessEdit);
  assert.equal(sent[0].text, nudgePrompt("You look stuck: 3 turns in a row edited only .harness files."));

  // The turn wrote implement-done: it has finished, so the counters stay where they were.
  writeFrontmatter(story, STUCK_CLEAR);
  writeFrontmatter(story, { ceremony_turns: 2, stuck_nudged: 1 });
  writeFileSync(join(worktree, ".harness", "state.md"), "# S1\n\n## Status\nimplement-done\n", "utf8");
  await sliceTurn(initiative, api, harnessEdit);
  assert.equal(storyMeta(state).ready, undefined);
  assert.deepEqual(steers, []);
  assert.equal(sent.length, 1);
  assert.equal(storyMeta(story).ceremony_turns, "2");
});

test("a QA seat that wrote test-done or test-failed is neither nudged nor blocked", async () => {
  const { root, worktree, story, state } = sliceFixture("a1");
  const { api, sent } = fakePaseo([{ id: "a1", labels: { kind: "factory-seat", seat: "qa", slice: "s1", mission: "m1" } }]);
  const { initiative, steers } = sliceStuckLoop(root);
  writeFrontmatter(state, { phase: "test", seat: "qa" });
  writeFrontmatter(story, { ceremony_turns: 2, stuck_nudged: 1 });

  for (const verdict of ["test-done", "test-failed"]) {
    writeFileSync(join(worktree, ".harness", "state.md"), `# S1\n\n## Status\n${verdict}\n`, "utf8");
    await sliceTurn(initiative, api, harnessEdit);
    assert.equal(storyMeta(state).ready, undefined, verdict);
  }
  assert.deepEqual([steers, sent], [[], []]);

  writeFileSync(join(worktree, ".harness", "state.md"), "# S1\n\n## Status\nrunning\n", "utf8");
  await sliceTurn(initiative, api, harnessEdit);
  assert.equal(storyMeta(state).ready, "blocked");
});
