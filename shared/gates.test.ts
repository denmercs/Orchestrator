import assert from "node:assert/strict";
import { test } from "node:test";
import { boardKey, gateRowLabel, gatesOf, needsYou, waitingLabel, type Gate } from "./gates";
import type { EpicBoard, EpicBoardState, EpicStory } from "./orchestration";

function story(id: string, fields: Partial<EpicStory> = {}): EpicStory {
  return {
    id,
    title: `Story ${id}`,
    status: "todo",
    dependsOn: [],
    blockedBy: "",
    blockedReason: "",
    blockedFrom: "",
    skillWarnings: "",
    discoveredFrom: "",
    pr: null,
    ci: "",
    workspace: "",
    agent: "",
    ready: false,
    track: "plan",
    ...fields,
  };
}

function board(repo: string, initiative: string, title: string, phase: string, stories: EpicStory[]): EpicBoard {
  const state: EpicBoardState = {
    epic: { id: phase, title: "Header and tabs", dir: `phases/${phase}-header-and-tabs` },
    initiative: title,
    initiativeSlug: initiative,
    loop: "on",
    plan: null,
    tracker: "local",
    next: { story: null, reason: "" },
    repoUrl: "",
    stories,
  };
  return { repo, initiative, state, error: null };
}

const STORIES = [
  story("S1", { status: "awaiting-approval" }),
  story("S2", { status: "pr-open", ci: "green", pr: 42 }),
  story("S3", { status: "blocked", blockedReason: "Needs a Jira key" }),
  story("S4", { status: "pr-open", ci: "pending", pr: 43 }),
  story("S5", { status: "pr-open", ci: "failing", pr: 44 }),
  story("S6", { status: "todo" }),
  story("S7", { status: "implementing" }),
  story("S8", { status: "merged", pr: 40 }),
  story("S9", { status: "pr-open", ci: "green", pr: null }),
  story("S10", { status: "blocked", blockedReason: "" }),
];

const BOARD = board("/repo", "orchestration-redesign", "Orchestration Redesign", "1", STORIES);

test("boardKey: repo and initiative on two lines", () => {
  assert.equal(boardKey(BOARD), "/repo\norchestration-redesign");
});

test("needsYou: plan awaiting approval, green PR and blocked wait on you; nothing else does", () => {
  assert.deepEqual(
    STORIES.filter(needsYou).map((item) => item.id),
    ["S1", "S2", "S3", "S9", "S10"],
  );
});

test("gatesOf: one gate per gated story on a board, with kind, text, board and where", () => {
  const where = "Orchestration Redesign · Phase 1";
  const key = "/repo\norchestration-redesign";
  const expected: Gate[] = [
    { kind: "plan", board: key, storyId: "S1", text: "Plan awaiting approval", where },
    { kind: "merge", board: key, storyId: "S2", text: "PR #42 ready to merge", where },
    { kind: "stuck", board: key, storyId: "S3", text: "Needs a Jira key", where },
    { kind: "merge", board: key, storyId: "S9", text: "PR ready to merge", where },
    { kind: "stuck", board: key, storyId: "S10", text: "Blocked", where },
  ];
  assert.deepEqual(gatesOf([BOARD]), expected);
});

test("gatesOf: a board with no state, or one that failed to load, has no gates", () => {
  const empty: EpicBoard = { repo: "/repo", initiative: "missing", state: null, error: null };
  const failed: EpicBoard = { repo: "/repo", initiative: "broken", state: null, error: "state.md not found" };
  assert.deepEqual(gatesOf([empty, failed]), []);
});

test("gatesOf: board order, then story order within each board", () => {
  const first = board("/a", "first", "First", "1", [
    story("A1", { status: "blocked" }),
    story("A2", { status: "todo" }),
    story("A3", { status: "awaiting-approval" }),
  ]);
  const missing: EpicBoard = { repo: "/b", initiative: "missing", state: null, error: "boom" };
  const second = board("/c", "second", "Second", "2", [
    story("C1", { status: "pr-open", ci: "green", pr: 7 }),
    story("C2", { status: "awaiting-approval" }),
  ]);
  assert.deepEqual(
    gatesOf([first, missing, second]).map((gate) => [gate.board, gate.storyId, gate.where]),
    [
      ["/a\nfirst", "A1", "First · Phase 1"],
      ["/a\nfirst", "A3", "First · Phase 1"],
      ["/c\nsecond", "C1", "Second · Phase 2"],
      ["/c\nsecond", "C2", "Second · Phase 2"],
    ],
  );
});

test("waitingLabel: nothing waiting, or a count of what waits on you", () => {
  assert.equal(waitingLabel(0), "Nothing is waiting on you");
  assert.equal(waitingLabel(1), "1 waiting on you");
  assert.equal(waitingLabel(3), "3 waiting on you");
});

test("gateRowLabel reads the gate text, then where it is", () => {
  const gate = { text: "Approve the plan", where: "Redesign · Phase 1 · S1" } as Gate;
  assert.equal(gateRowLabel(gate), "Approve the plan, Redesign · Phase 1 · S1");
});
