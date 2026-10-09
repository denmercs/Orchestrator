import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPROVE_MESSAGE,
  createGateActions,
  NUDGE_MESSAGE,
  type GatePort,
  type GateResult,
  type GateStory,
} from "./gate-actions";

const BOARD = "/repo\norchestration-redesign";

// A fake port: stories and live agents are set per test, and every send is captured.
function fakePort(
  stories: Record<string, GateStory>,
  live: string[] = [],
  freshResult: GateResult = { ok: true, error: null, agentId: "f1" },
) {
  // Every port call in order, so a test can check what happened first.
  const calls: string[] = [];
  const sent: [string, string][] = [];
  const reopened: string[] = [];
  const fresh: string[] = [];
  const port: GatePort = {
    story: async ({ storyId }) => stories[storyId] ?? null,
    isLive: async (agentId) => live.includes(agentId),
    send: async (agentId, text) => {
      calls.push("send");
      sent.push([agentId, text]);
    },
    startFresh: async (agentId) => {
      calls.push("startFresh");
      fresh.push(agentId);
      return freshResult;
    },
    reopen: async ({ storyId }) => {
      calls.push("reopen");
      reopened.push(storyId);
    },
  };
  return { port, sent, reopened, fresh, calls };
}

test("approve: an awaiting-approval story with a live agent is sent the approve message", async () => {
  const { port, sent } = fakePort({ S12: { status: "awaiting-approval", agent: "a1", waitingOn: null } }, ["a1"]);
  const result = await createGateActions(port).act({ board: BOARD, storyId: "S12", action: "approve" });
  assert.deepEqual(result, { ok: true, error: null, agentId: "a1" });
  assert.deepEqual(sent, [["a1", "Approved. Go ahead."]]);
  assert.equal(APPROVE_MESSAGE, "Approved. Go ahead.");
});

// Each refusal: the error names why, and nothing is sent, started or reopened.
const refusals: [string, Record<string, GateStory>, string[], string, "approve" | "nudge" | "restart", string][] = [
  [
    "approve on a story that has moved on to implementing",
    { S12: { status: "implementing", agent: "a1", waitingOn: null } },
    ["a1"],
    "S12",
    "approve",
    "S12 is now implementing, not awaiting approval.",
  ],
  [
    "nudge on a story awaiting approval",
    { S12: { status: "awaiting-approval", agent: "a1", waitingOn: null } },
    ["a1"],
    "S12",
    "nudge",
    "S12 is now awaiting-approval, not blocked.",
  ],
  ["a story that isn't on the board", {}, ["a1"], "S99", "approve", "S99 is not on that board."],
  [
    "a story with no agent",
    { S12: { status: "awaiting-approval", agent: null, waitingOn: null } },
    [],
    "S12",
    "approve",
    "S12 has no live agent.",
  ],
  [
    "a story whose agent is unknown or archived",
    { S12: { status: "awaiting-approval", agent: "gone", waitingOn: null } },
    ["a1"],
    "S12",
    "approve",
    "S12 has no live agent.",
  ],
  [
    "nudge on a story waiting on a permission",
    { S12: { status: "blocked", agent: "a1", waitingOn: "permission" } },
    ["a1"],
    "S12",
    "nudge",
    "S12 is waiting on a permission; answer it in the session.",
  ],
  [
    "restart on a story waiting on a permission",
    { S12: { status: "blocked", agent: "a1", waitingOn: "permission" } },
    ["a1"],
    "S12",
    "restart",
    "S12 is waiting on a permission; answer it in the session.",
  ],
];

for (const [name, stories, live, storyId, action, error] of refusals) {
  test(`refused: ${name}`, async () => {
    const { port, sent, reopened, fresh } = fakePort(stories, live);
    const result = await createGateActions(port).act({ board: BOARD, storyId, action });
    assert.deepEqual(result, { ok: false, error, agentId: null });
    assert.deepEqual(sent, []);
    assert.deepEqual(reopened, []);
    assert.deepEqual(fresh, []);
  });
}

test("nudge: a blocked story's agent is sent the nudge, then the story is reopened", async () => {
  const { port, sent, reopened, fresh, calls } = fakePort(
    { S12: { status: "blocked", agent: "a1", waitingOn: null } },
    ["a1"],
  );
  const result = await createGateActions(port).act({ board: BOARD, storyId: "S12", action: "nudge" });
  assert.deepEqual(result, { ok: true, error: null, agentId: "a1" });
  assert.deepEqual(sent, [["a1", "You look stuck: say what's blocking you, or take a different approach."]]);
  assert.equal(NUDGE_MESSAGE, "You look stuck: say what's blocking you, or take a different approach.");
  assert.deepEqual(reopened, ["S12"]);
  assert.deepEqual(fresh, []);
  assert.deepEqual(calls, ["send", "reopen"]);
});

test("restart: a blocked story's agent is started fresh, then the story is reopened with the new session", async () => {
  const { port, sent, reopened, fresh, calls } = fakePort(
    { S12: { status: "blocked", agent: "a1", waitingOn: null } },
    ["a1"],
  );
  const result = await createGateActions(port).act({ board: BOARD, storyId: "S12", action: "restart" });
  assert.deepEqual(result, { ok: true, error: null, agentId: "f1" });
  assert.deepEqual(fresh, ["a1"]);
  assert.deepEqual(reopened, ["S12"]);
  assert.deepEqual(sent, []);
  assert.deepEqual(calls, ["startFresh", "reopen"]);
});

test("restart: a fresh start that refuses returns its error unchanged and nothing is reopened", async () => {
  const refusal = { ok: false, error: "Wait for the turn to end, then start fresh.", agentId: null };
  const { port, reopened, fresh } = fakePort(
    { S12: { status: "blocked", agent: "a1", waitingOn: null } },
    ["a1"],
    refusal,
  );
  const result = await createGateActions(port).act({ board: BOARD, storyId: "S12", action: "restart" });
  assert.deepEqual(result, refusal);
  assert.deepEqual(fresh, ["a1"]);
  assert.deepEqual(reopened, []);
});

test("changes: an awaiting-approval story returns its agent id and nothing is sent", async () => {
  const { port, calls } = fakePort({ S12: { status: "awaiting-approval", agent: "a1", waitingOn: null } }, ["a1"]);
  const result = await createGateActions(port).act({ board: BOARD, storyId: "S12", action: "changes" });
  assert.deepEqual(result, { ok: true, error: null, agentId: "a1" });
  assert.deepEqual(calls, []);
});
