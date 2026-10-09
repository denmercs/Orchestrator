import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextStatus } from "../shared/context";
import type { EpicBoard, EpicBoardState, EpicStory } from "../shared/orchestration";
import {
  IDLE_POLL_MS,
  POLL_MS,
  boardKey,
  contextAgents,
  edgeTone,
  emptyLine,
  findSelected,
  mergedProgress,
  nodeContext,
  nodeKind,
  pollDelay,
  sectionAction,
  sectionLine,
  sectionNote,
  showFold,
  toggleFold,
} from "./epic-board-model";

function board(state: Partial<EpicBoardState> | null, rest: Partial<EpicBoard> = {}): EpicBoard {
  return {
    repo: "/repo",
    initiative: "redesign",
    state:
      state &&
      ({
        epic: { id: "1", title: "Phase 1", dir: "phases/1" },
        initiative: "Redesign",
        initiativeSlug: "redesign",
        loop: "off",
        plan: { warnings: [], jira: false, status: "agreed" },
        tracker: "local",
        next: { story: null, reason: "" },
        repoUrl: "",
        stories: [],
        ...state,
      } as EpicBoardState),
    error: null,
    ...rest,
  };
}

test("boardKey joins repo and initiative", () => {
  assert.equal(boardKey(board(null, { repo: "/a", initiative: "b" })), "/a\nb");
});

test("pollDelay is fast before the first read", () => {
  assert.equal(POLL_MS, 3000);
  assert.equal(pollDelay(null), POLL_MS);
});

test("pollDelay is fast while any board is lively", () => {
  assert.equal(pollDelay([board({}), board({ loop: "on" })]), POLL_MS);
  assert.equal(pollDelay([board({ plan: null })]), POLL_MS);
  assert.equal(pollDelay([board({ plan: { warnings: [], jira: false, status: "draft" } })]), POLL_MS);
});

test("pollDelay is slow when every board is settled", () => {
  assert.equal(IDLE_POLL_MS, 10_000);
  assert.equal(pollDelay([board({}), board(null)]), IDLE_POLL_MS);
  assert.equal(pollDelay([]), IDLE_POLL_MS);
});

test("toggleFold adds then removes a key and leaves the input alone", () => {
  const empty = new Set<string>();
  const folded = toggleFold(empty, "a");
  assert.notEqual(folded, empty);
  assert.deepEqual([...empty], []);
  assert.deepEqual([...folded], ["a"]);
  const shown = toggleFold(folded, "a");
  assert.notEqual(shown, folded);
  assert.deepEqual([...folded], ["a"]);
  assert.deepEqual([...shown], []);
});

test("showFold removes a folded key, is a copy when it isn't folded, and leaves the input alone", () => {
  const folded = new Set(["a", "b"]);
  const shown = showFold(folded, "a");
  assert.notEqual(shown, folded);
  assert.deepEqual([...folded], ["a", "b"]);
  assert.deepEqual([...shown], ["b"]);
  const same = showFold(folded, "c");
  assert.notEqual(same, folded);
  assert.deepEqual([...same], ["a", "b"]);
  assert.deepEqual([...folded], ["a", "b"]);
});

function story(id: string): EpicStory {
  return { id, title: id, status: "todo", dependsOn: [], blockedBy: "", blockedReason: "", blockedFrom: "" } as unknown as EpicStory;
}

test("findSelected resolves the selected board and story", () => {
  const one = board({ stories: [story("S1"), story("S2")] });
  const other = board({ stories: [story("S1")] }, { initiative: "other" });
  const found = findSelected([other, one], { board: boardKey(one), story: "S2" });
  assert.equal(found?.board, one);
  assert.equal(found?.story.id, "S2");
});

test("findSelected is null when nothing matches", () => {
  const one = board({ stories: [story("S1")] });
  const empty = board(null, { initiative: "empty" });
  assert.equal(findSelected([one], null), null);
  assert.equal(findSelected(null, { board: boardKey(one), story: "S1" }), null);
  assert.equal(findSelected([one], { board: "/repo\nnope", story: "S1" }), null);
  assert.equal(findSelected([one], { board: boardKey(one), story: "S9" }), null);
  assert.equal(findSelected([empty], { board: boardKey(empty), story: "S1" }), null);
});

function at(status: string, rest: Partial<EpicStory> = {}): EpicStory {
  return { ...story("S1"), status, ci: "", pr: null, ready: false, ...rest } as EpicStory;
}

test("nodeKind sorts a story into the legend's five kinds", () => {
  assert.equal(nodeKind(at("merged")), "merged");
  assert.equal(nodeKind(at("awaiting-approval")), "needs-you");
  assert.equal(nodeKind(at("blocked")), "needs-you");
  assert.equal(nodeKind(at("pr-open", { ci: "green" })), "needs-you");
  assert.equal(nodeKind(at("implementing")), "running");
  assert.equal(nodeKind(at("todo", { ready: true })), "ready");
  assert.equal(nodeKind(at("todo", { ready: false })), "waiting");
});

test("mergedProgress counts merged stories as a whole percent", () => {
  const stories = [at("merged"), at("merged"), at("implementing"), at("todo"), at("blocked")];
  assert.deepEqual(mergedProgress(stories), { merged: 2, total: 5, pct: 40 });
  assert.deepEqual(mergedProgress([]), { merged: 0, total: 0, pct: 0 });
});

const state = (rest: Partial<EpicBoardState> = {}) => board(rest).state as EpicBoardState;

test("sectionLine reads phase label, title and tracker word", () => {
  assert.equal(sectionLine(state({ epic: { id: "1", title: "Foundations", dir: "" } })), "Phase 1: Foundations · local");
  assert.equal(sectionLine(state({ epic: { id: "2", title: "Board", dir: "" }, tracker: "jira" })), "Phase 2: Board · Jira");
  assert.equal(sectionLine(state({ epic: { id: "", title: "Loose", dir: "" } })), "Loose · local");
});

test("sectionAction picks the header's one next step", () => {
  const two = [at("merged"), at("todo", { ready: true })];
  assert.deepEqual(sectionAction(state({ loop: "on", stories: two }), null), { kind: "stop", label: "Stop" });
  assert.deepEqual(sectionAction(state({ stories: two }), null), { kind: "start", label: "Start" });
  const draft = { warnings: [], jira: false, status: "draft" };
  assert.deepEqual(sectionAction(state({ stories: two, plan: draft }), null), { kind: "plan", label: "View plan" });
  assert.deepEqual(sectionAction(state({ stories: [], plan: null }), null), { kind: "start-planning", label: "Start planning" });
  assert.deepEqual(sectionAction(state({ stories: [], plan: draft }), null), { kind: "plan", label: "View plan" });
  assert.deepEqual(sectionAction(state({ stories: [at("merged")] }), null), { kind: "plan", label: "View plan" });
  assert.equal(sectionAction(state({ stories: [at("merged")], plan: null }), null), null);
});

test("sectionAction shows a busy label while its action runs", () => {
  const two = [at("todo", { ready: true })];
  assert.equal(sectionAction(state({ loop: "on", stories: two }), "loop-stop:")?.label, "Stopping…");
  assert.equal(sectionAction(state({ stories: two }), "loop-start:")?.label, "Starting…");
  assert.equal(sectionAction(state({ stories: [at("merged")] }), "plan-open:")?.label, "Opening…");
  assert.equal(sectionAction(state({ stories: [], plan: null }), "plan-phase:")?.label, "Starting…");
  assert.equal(sectionAction(state({ stories: two }), "delete:")?.label, "Start");
});

test("contextAgents lists the agents of running and blocked stories", () => {
  const stories = [
    at("planning", { agent: "a1" }),
    at("implementing", { agent: "a2" }),
    at("reviewing", { agent: "a3" }),
    at("pr-open", { agent: "a4" }),
    at("blocked", { agent: "a5" }),
    at("merged", { agent: "m" }),
    at("todo", { agent: "t" }),
    at("awaiting-approval", { agent: "w" }),
    at("implementing", { agent: "" }),
  ];
  assert.deepEqual(contextAgents(stories), ["a1", "a2", "a3", "a4", "a5"]);
});

function status(used: number | null, max: number | null, rest: Partial<ContextStatus["reading"]> = {}): ContextStatus {
  return {
    agentId: "a1",
    reading: { used, max, level: "amber", capability: "full", strategy: "native", ...rest },
    warned: [],
    mode: "normal",
    red: 150_000,
  };
}

test("nodeContext turns a reading into the node's $ bar", () => {
  assert.deepEqual(nodeContext(status(124_000, 200_000)), { pct: 62, level: "amber", act: 75, label: "62%" });
  assert.equal(nodeContext(status(300_000, 200_000, { level: "red" }))?.pct, 100);
  assert.equal(nodeContext(status(null, 200_000)), null);
  assert.equal(nodeContext(status(124_000, null)), null);
  assert.equal(nodeContext(null), null);
});

test("edgeTone colours an arrow by its two ends", () => {
  assert.equal(edgeTone(at("todo"), at("merged")), "success");
  assert.equal(edgeTone(at("blocked"), at("merged")), "danger");
  assert.equal(edgeTone(at("todo"), at("blocked")), "danger");
  assert.equal(edgeTone(at("todo"), at("implementing")), "muted");
  assert.equal(edgeTone(at("todo"), undefined), "muted");
});

test("emptyLine asks for a plan, or says one is being written", () => {
  assert.equal(emptyLine(state({ stories: [], plan: null })), "No stories yet. Plan this initiative to break it into stories.");
  const draft = { warnings: [], jira: false, status: "draft" };
  assert.equal(emptyLine(state({ stories: [], plan: draft })), "Planning in progress. Stories appear once the plan is locked.");
});

test("sectionNote keeps the loop and plan banners as one amber line", () => {
  const stories = [at("merged"), at("implementing"), at("todo"), at("todo")];
  assert.equal(
    sectionNote(state({ loop: "on", stories })),
    "Running Phase 1: Phase 1: 1 in progress · 1 merged · 2 waiting. Stop only keeps new work from starting.",
  );
  assert.equal(
    sectionNote(state({ stories })),
    "Planning done. Start runs Redesign phase by phase: each ready story gets its own worktree, and the rest follow as their dependencies merge.",
  );
  const draft = { warnings: [], jira: false, status: "draft" };
  assert.equal(sectionNote(state({ stories, plan: draft })), 'Planning in progress. Say "lock" in the architecture session when the plan is ready.');
  assert.equal(sectionNote(state({ stories: [], plan: draft })), null);
  assert.equal(sectionNote(state({ stories: [at("merged")] })), null);
});
