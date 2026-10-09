import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPROVE_MESSAGE,
  createGateActions,
  loopGatePort,
  NUDGE_MESSAGE,
  RETRY_MESSAGE,
  type GatePort,
  type GateResult,
  type GateStory,
} from "./gate-actions";

const BOARD = "/repo\norchestration-redesign";

// A fake port: stories, live agents and ended (closed or errored) ones are set per test, and every
// send is captured.
function fakePort(
  stories: Record<string, GateStory>,
  live: string[] = [],
  freshResult: GateResult = { ok: true, error: null, agentId: "f1" },
  ended: string[] = [],
  retryResult: GateResult = { ok: true, error: null, agentId: "r1" },
) {
  // Every port call in order, so a test can check what happened first.
  const calls: string[] = [];
  const sent: [string, string][] = [];
  const reopened: string[] = [];
  const fresh: string[] = [];
  const retried: string[] = [];
  const port: GatePort = {
    story: async ({ storyId }) => stories[storyId] ?? null,
    session: async (agentId) => (live.includes(agentId) ? "open" : ended.includes(agentId) ? "ended" : null),
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
    retryStep: async ({ storyId }) => {
      calls.push("retryStep");
      retried.push(storyId);
      return retryResult;
    },
  };
  return { port, sent, reopened, fresh, retried, calls };
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

for (const action of ["approve", "nudge"] as const) {
  const status = action === "approve" ? "awaiting-approval" : "blocked";
  test(`refused: ${action} on a story whose session has ended`, async () => {
    const { port, sent, reopened } = fakePort({ S12: { status, agent: "a1", waitingOn: null } }, [], undefined, ["a1"]);
    const result = await createGateActions(port).act({ board: BOARD, storyId: "S12", action });
    assert.deepEqual(result, { ok: false, error: "S12 has no live agent.", agentId: null });
    assert.deepEqual(sent, []);
    assert.deepEqual(reopened, []);
  });
}

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

test("restart: a blocked story whose session has ended is started fresh", async () => {
  const { port, fresh, reopened } = fakePort({ S12: { status: "blocked", agent: "a1", waitingOn: null } }, [], undefined, [
    "a1",
  ]);
  const result = await createGateActions(port).act({ board: BOARD, storyId: "S12", action: "restart" });
  assert.deepEqual(result, { ok: true, error: null, agentId: "f1" });
  assert.deepEqual(fresh, ["a1"]);
  assert.deepEqual(reopened, ["S12"]);
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

// Retry reads the block kind: a start, PR or CI block has no agent to wake, so the story is only
// reopened and the loop picks it up again.
for (const blockKind of ["start", "pr", "ci"] as const) {
  test(`retry: a ${blockKind} block is reopened only`, async () => {
    const { port, calls } = fakePort({ S12: { status: "blocked", agent: "a1", waitingOn: null, blockKind } }, ["a1"]);
    const result = await createGateActions(port).act({ board: BOARD, storyId: "S12", action: "retry" });
    assert.deepEqual(result, { ok: true, error: null, agentId: null });
    assert.deepEqual(calls, ["reopen"]);
  });
}

for (const blockKind of ["retry-limit", "step", null] as const) {
  test(`retry: a ${blockKind ?? "kind-less"} block with an open session is reopened, then told to carry on`, async () => {
    const { port, sent, calls } = fakePort(
      { S12: { status: "blocked", agent: "a1", waitingOn: null, blockKind } },
      ["a1"],
    );
    const result = await createGateActions(port).act({ board: BOARD, storyId: "S12", action: "retry" });
    assert.deepEqual(result, { ok: true, error: null, agentId: "a1" });
    assert.deepEqual(calls, ["reopen", "send"]);
    assert.deepEqual(sent, [["a1", RETRY_MESSAGE]]);
    assert.equal(
      RETRY_MESSAGE,
      "The block on this step is cleared. Carry on from `.harness/state.md` and write the step's marker when you finish.",
    );
  });
}

// An ended or unknown session can't take a message: the loop starts the step again in a fresh session.
for (const [name, ended] of [
  ["ended", ["a1"]],
  ["unknown", []],
] as const) {
  test(`retry: a step block whose session is ${name} starts the step again, with the new session's id`, async () => {
    const { port, retried, calls } = fakePort(
      { S12: { status: "blocked", agent: "a1", waitingOn: null, blockKind: "step" } },
      [],
      undefined,
      [...ended],
    );
    const result = await createGateActions(port).act({ board: BOARD, storyId: "S12", action: "retry" });
    assert.deepEqual(result, { ok: true, error: null, agentId: "r1" });
    assert.deepEqual(retried, ["S12"]);
    assert.deepEqual(calls, ["retryStep"]);
  });
}

test("retry: a step block with no agent is reopened only", async () => {
  const { port, calls } = fakePort({ S12: { status: "blocked", agent: null, waitingOn: null, blockKind: "step" } });
  const result = await createGateActions(port).act({ board: BOARD, storyId: "S12", action: "retry" });
  assert.deepEqual(result, { ok: true, error: null, agentId: null });
  assert.deepEqual(calls, ["reopen"]);
});

test("refused: retry on a story that isn't blocked", async () => {
  const { port, calls } = fakePort({ S12: { status: "implementing", agent: "a1", waitingOn: null, blockKind: null } }, [
    "a1",
  ]);
  const result = await createGateActions(port).act({ board: BOARD, storyId: "S12", action: "retry" });
  assert.deepEqual(result, { ok: false, error: "S12 is now implementing, not blocked.", agentId: null });
  assert.deepEqual(calls, []);
});

test("refused: retry on a story waiting on a permission in an open session", async () => {
  const { port, calls } = fakePort({ S12: { status: "blocked", agent: "a1", waitingOn: "permission", blockKind: null } }, [
    "a1",
  ]);
  const result = await createGateActions(port).act({ board: BOARD, storyId: "S12", action: "retry" });
  assert.deepEqual(result, { ok: false, error: "S12 is waiting on a permission; answer it in the session.", agentId: null });
  assert.deepEqual(calls, []);
});

test("retry: a fresh step start that refuses returns its error unchanged", async () => {
  const refusal = { ok: false, error: "S12 has no step to start again.", agentId: null };
  const { port, calls } = fakePort(
    { S12: { status: "blocked", agent: "a1", waitingOn: null, blockKind: "step" } },
    [],
    undefined,
    ["a1"],
    refusal,
  );
  const result = await createGateActions(port).act({ board: BOARD, storyId: "S12", action: "retry" });
  assert.deepEqual(result, refusal);
  assert.deepEqual(calls, ["retryStep"]);
});

// The real port against a fake loop and Paseo handle.
function realPort(agents: Record<string, { status: string; archivedAt?: string } | Error>) {
  const looked: unknown[] = [];
  const reopened: unknown[] = [];
  const retried: unknown[] = [];
  const sent: [string, string][] = [];
  const loop = {
    gateStory: async (ref: { repo: string; initiative: string; storyId: string }) => {
      looked.push(ref);
      return { status: "blocked", agent: "a1", waitingOn: null };
    },
    reopen: async (ref: { repo: string; initiative: string; storyId: string }) => {
      reopened.push(ref);
    },
    retryStep: async (api: unknown, ref: { repo: string; initiative: string; storyId: string }) => {
      retried.push([api, ref]);
      return { ok: true, error: null, agentId: "r1" };
    },
  };
  const paseo = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => {
          const agent = agents[id];
          if (agent instanceof Error) throw agent;
          return agent ? { agent } : null;
        },
        send: async (text: string) => {
          sent.push([id, text]);
        },
      }),
    },
  } as unknown as Parameters<typeof loopGatePort>[1];
  const contextWatch = { act: async () => ({ ok: true, error: null, agentId: "f1", kind: "fresh" }) };
  const port = loopGatePort(loop, paseo, contextWatch as unknown as Parameters<typeof loopGatePort>[2]);
  return { port, looked, reopened, retried, sent, paseo };
}

test("loopGatePort: the board key is split into repo and initiative for the loop", async () => {
  const { port, looked, reopened } = realPort({});
  assert.deepEqual(await port.story({ board: BOARD, storyId: "S12" }), { status: "blocked", agent: "a1", waitingOn: null });
  await port.reopen({ board: BOARD, storyId: "S12" });
  const ref = { repo: "/repo", initiative: "orchestration-redesign", storyId: "S12" };
  assert.deepEqual(looked, [ref]);
  assert.deepEqual(reopened, [ref]);
});

test("loopGatePort: retryStep hands the loop the Paseo handle and the split board key", async () => {
  const { port, retried, paseo } = realPort({});
  assert.deepEqual(await port.retryStep({ board: BOARD, storyId: "S12" }), { ok: true, error: null, agentId: "r1" });
  assert.deepEqual(retried, [[paseo, { repo: "/repo", initiative: "orchestration-redesign", storyId: "S12" }]]);
  assert.deepEqual(await port.retryStep({ board: "no-newline", storyId: "S12" }), {
    ok: false,
    error: "S12 is not on that board.",
    agentId: null,
  });
  assert.equal(retried.length, 1);
});

for (const board of ["no-newline", "\ninitiative", "/repo\n"]) {
  test(`loopGatePort: a board key that doesn't split (${JSON.stringify(board)}) finds no story and reopens nothing`, async () => {
    const { port, looked, reopened } = realPort({});
    assert.equal(await port.story({ board, storyId: "S12" }), null);
    await port.reopen({ board, storyId: "S12" });
    assert.deepEqual(looked, []);
    assert.deepEqual(reopened, []);
  });
}

test("loopGatePort: a session is open, ended (closed or errored), or null when unknown, archived or unreachable", async () => {
  const { port } = realPort({
    idle: { status: "idle" },
    running: { status: "running" },
    closed: { status: "closed" },
    errored: { status: "error" },
    archived: { status: "idle", archivedAt: "2026-10-08T00:00:00Z" },
    broken: new Error("Paseo is down"),
  });
  const seen = await Promise.all(
    ["idle", "running", "closed", "errored", "archived", "broken", "unknown"].map((id) => port.session(id)),
  );
  assert.deepEqual(seen, ["open", "open", "ended", "ended", null, null, null]);
});

test("loopGatePort: send and Start fresh reach Paseo and the context watch", async () => {
  const { port, sent } = realPort({});
  await port.send("a1", NUDGE_MESSAGE);
  assert.deepEqual(sent, [["a1", NUDGE_MESSAGE]]);
  assert.deepEqual(await port.startFresh("a1"), { ok: true, error: null, agentId: "f1" });
});
