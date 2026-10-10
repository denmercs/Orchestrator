import assert from "node:assert/strict";
import { test } from "node:test";
import type { FreshPort } from "./compactor";
import type { TelemetryRow } from "./context-telemetry";
import { createContextWatch, type TurnEnded, type WatchAgent, type WatchPort } from "./context-watch";

type Item = TurnEnded["timeline"][number];

// A fake port: agents are set per test, and every row and sent message is captured.
function fakePort(agents: Record<string, WatchAgent>) {
  const rows: TelemetryRow[] = [];
  const sent: [string, string][] = [];
  const fresh: string[] = [];
  // The handoff turn waits on this, so a test can hold a fresh compact mid-way.
  let handoffGate: Promise<void> = Promise.resolve();
  const freshPort: FreshPort = {
    session: async (id) =>
      agents[id]
        ? { workspaceId: "ws1", cwd: "/repo", config: { provider: "claude/opus" }, title: id, labels: agents[id].labels, running: false }
        : null,
    handoff: async (id) => {
      fresh.push(`handoff ${id}`);
      await handoffGate;
    },
    create: async (input) => {
      fresh.push(`create ${input.labels["context-from"]}`);
      return "f1";
    },
    archive: async (id) => {
      fresh.push(`archive ${id}`);
    },
    loopPrompt: async () => null,
    handOver: async () => undefined,
  };
  const port: WatchPort = {
    readAgent: async (id) => agents[id] ?? null,
    send: async (id, text) => {
      sent.push([id, text]);
    },
    record: async (row) => {
      rows.push(row);
    },
    thresholds: async () => ({ amber: 100_000, red: 150_000 }),
    now: () => "2026-10-07T12:00:00.000Z",
    fresh: freshPort,
  };
  return {
    port,
    rows,
    sent,
    fresh,
    holdHandoff(gate: Promise<void>) {
      handoffGate = gate;
    },
  };
}

function agent(
  used: number | null,
  labels: Record<string, string> = {},
  commands = ["compact"],
  model: string | null = null,
  costUsd: number | null = null,
): WatchAgent {
  return {
    usage: used === null ? null : { contextWindowUsedTokens: used, contextWindowMaxTokens: 200_000 },
    commands: commands.map((name) => ({ name })),
    labels,
    model,
    costUsd,
  };
}

function turn(
  id: string,
  timeline: Item[] = [],
  { turnId = null, outcome = { kind: "completed" } }: Partial<Pick<TurnEnded, "turnId" | "outcome">> = {},
): TurnEnded {
  return { agent: { id, provider: "claude" }, timeline, turnId, outcome };
}

test("onTurnEnded: one turn end writes one turn row with provider and step", async () => {
  const { port, rows } = fakePort({
    a1: agent(
      40_000,
      { "loop-step": "implement", "loop-story": "S2", "loop-initiative": "telemetry" },
      ["compact"],
      null,
      0.42,
    ),
  });
  await createContextWatch(port).onTurnEnded(turn("a1"));

  assert.deepEqual(rows, [
    {
      at: "2026-10-07T12:00:00.000Z",
      agentId: "a1",
      provider: "claude",
      step: "implement",
      used: 40_000,
      max: 200_000,
      event: "turn",
      model: null,
      cycle: null,
      story: "S2",
      initiative: "telemetry",
      costUsd: 0.42,
      explore: { reads: 0, searches: 0, files: 0, chars: 0, edited: false },
      turnId: null,
      turnCostUsd: 0.42,
    },
  ]);
});

test("onTurnEnded: the same turn end twice, at once or later, writes one turn row", async () => {
  const { port, rows } = fakePort({ a1: agent(40_000) });
  const watch = createContextWatch(port);
  await Promise.all([watch.onTurnEnded(turn("a1", [], { turnId: "t1" })), watch.onTurnEnded(turn("a1", [], { turnId: "t1" }))]);
  await watch.onTurnEnded(turn("a1", [], { turnId: "t1" }));
  assert.deepEqual(rows.map((r) => [r.event, r.turnId]), [["turn", "t1"]]);

  await watch.onTurnEnded(turn("a1", [], { turnId: "t2" }));
  assert.deepEqual(rows.map((r) => [r.event, r.turnId]), [["turn", "t1"], ["turn", "t2"]]);
});

test("onTurnEnded: a turn row's cost is null when the agent reports none", async () => {
  const { port, rows } = fakePort({ a1: agent(40_000) });
  await createContextWatch(port).onTurnEnded(turn("a1"));

  assert.deepEqual(
    rows.map((r) => [r.event, r.costUsd]),
    [["turn", null]],
  );
});

test("onTurnEnded: a turn row carries the agent's model and its loop cycle, story and initiative", async () => {
  const { port, rows } = fakePort({
    a1: agent(
      40_000,
      { "loop-step": "implement", "loop-cycle": "2", "loop-story": "S6", "loop-initiative": "skills" },
      ["compact"],
      "opus",
    ),
    a2: agent(40_000),
  });
  const watch = createContextWatch(port);
  await watch.onTurnEnded(turn("a1"));
  await watch.onTurnEnded(turn("a2"));

  assert.deepEqual(
    rows.map((r) => [r.agentId, r.model, r.cycle, r.story, r.initiative]),
    [
      ["a1", "opus", 2, "S6", "skills"],
      ["a2", null, null, null, null],
    ],
  );
});

test("onTurnEnded: a loop-cycle label that is not all digits records a null cycle", async () => {
  const { port, rows } = fakePort({
    a1: agent(40_000, { "loop-cycle": "x" }),
    a2: agent(40_000, { "loop-cycle": "" }),
    a3: agent(40_000, { "loop-cycle": "0x10" }),
  });
  const watch = createContextWatch(port);
  await watch.onTurnEnded(turn("a1"));
  await watch.onTurnEnded(turn("a2"));
  await watch.onTurnEnded(turn("a3"));

  assert.deepEqual(
    rows.map((r) => [r.agentId, r.cycle]),
    [
      ["a1", null],
      ["a2", null],
      ["a3", null],
    ],
  );
});

test("onTurnEnded: crossing 100k on two turns writes a single warning row", async () => {
  const agents = { a1: agent(110_000) };
  const { port, rows } = fakePort(agents);
  const watch = createContextWatch(port);
  await watch.onTurnEnded(turn("a1"));
  agents.a1 = agent(120_000);
  await watch.onTurnEnded(turn("a1"));

  assert.deepEqual(
    rows.map((r) => [r.event, r.level]),
    [
      ["turn", undefined],
      ["warning", "amber"],
      ["turn", undefined],
    ],
  );
});

test("onTurnEnded: a Basic session still writes a turn row with null used", async () => {
  const { port, rows } = fakePort({ a1: agent(null, {}, []) });
  await createContextWatch(port).onTurnEnded(turn("a1"));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, "turn");
  assert.equal(rows[0].used, null);
  assert.equal(rows[0].step, null);
});

test("onTurnEnded: an unknown agent writes no row", async () => {
  const { port, rows } = fakePort({});
  await createContextWatch(port).onTurnEnded(turn("gone"));
  assert.deepEqual(rows, []);
});

const user: Item = { type: "user_message" };
const reply: Item = { type: "assistant_message" };
const compacted: Item = { type: "compaction", status: "completed", preTokens: 160_000 };

test("onTurnEnded: a canceled or failed turn end writes turn.stopped, not turn, and still counts its items and warns", async () => {
  const agents = { a1: agent(160_000) };
  const { port, rows } = fakePort(agents);
  const watch = createContextWatch(port);
  await watch.onTurnEnded(turn("a1", [user, reply]));
  agents.a1 = agent(30_000);
  await watch.onTurnEnded(turn("a1", [user, reply, user, compacted], { outcome: { kind: "canceled", reason: "x" } }));
  agents.a1 = agent(160_000);
  await watch.onTurnEnded(
    turn("a1", [user, reply, user, compacted, user], { outcome: { kind: "failed", error: { message: "boom" } } }),
  );
  await watch.onTurnEnded(turn("a1", [user, reply, user, compacted, user, reply]));

  // The compaction is counted once and re-arms the warning; only completed turn ends write a turn row.
  assert.deepEqual(
    rows.map((r) => [r.event, r.used]),
    [
      ["turn", 160_000],
      ["warning", 160_000],
      ["compact.native", 30_000],
      ["turn.stopped", 30_000],
      ["turn.stopped", 160_000],
      ["warning", 160_000],
      ["turn", 160_000],
    ],
  );
});

test("onTurnEnded: turnCostUsd is this turn's share of the session's running costUsd", async () => {
  const agents = { a1: agent(40_000, {}, ["compact"], null, 0.5) };
  const { port, rows } = fakePort(agents);
  const watch = createContextWatch(port);
  await watch.onTurnEnded(turn("a1", [user, reply]));
  agents.a1 = agent(40_000, {}, ["compact"], null, 1.25);
  // A canceled turn's spend goes on its own turn.stopped row, so an agent whose last turn fails still counts.
  await watch.onTurnEnded(turn("a1", [user, reply, user], { outcome: { kind: "canceled", reason: "x" } }));
  agents.a1 = agent(40_000, {}, ["compact"], null, 2);
  await watch.onTurnEnded(turn("a1", [user, reply, user, user, reply]));

  assert.deepEqual(
    rows.map((r) => [r.event, r.costUsd, r.turnCostUsd]),
    [["turn", 0.5, 0.5], ["turn.stopped", 1.25, 0.75], ["turn", 2, 0.75]],
  );
  assert.equal(rows.reduce((sum, r) => sum + (r.turnCostUsd ?? 0), 0), rows[rows.length - 1].costUsd);
});

test("onTurnEnded: turnCostUsd is null when the cost is null or the session was first seen mid-way", async () => {
  const agents = { none: agent(40_000), mid: agent(40_000, {}, ["compact"], null, 3) };
  const { port, rows } = fakePort(agents);
  const watch = createContextWatch(port);
  await watch.onTurnEnded(turn("none", [user, reply]));
  await watch.onTurnEnded(turn("mid", [user, reply, user, reply]));
  agents.mid = agent(40_000, {}, ["compact"], null, 3.5);
  await watch.onTurnEnded(turn("mid", [user, reply, user, reply, user, reply]));

  assert.deepEqual(
    rows.map((r) => [r.agentId, r.costUsd, r.turnCostUsd]),
    [["none", null, null], ["mid", 3, null], ["mid", 3.5, 0.5]],
  );
});

test("onTurnEnded: only turn rows carry turnCostUsd", async () => {
  const { port, rows } = fakePort({ a1: agent(160_000, {}, ["compact"], null, 1) });
  await createContextWatch(port).onTurnEnded(turn("a1", [user, reply]));

  assert.deepEqual(
    rows.map((r) => [r.event, "turnCostUsd" in r]),
    [["turn", true], ["warning", false]],
  );
});

test("onTurnEnded: a new completed compaction item writes compact.native and re-arms warnings", async () => {
  const agents = { a1: agent(160_000) };
  const { port, rows } = fakePort(agents);
  const watch = createContextWatch(port);
  await watch.onTurnEnded(turn("a1", [user, reply]));
  agents.a1 = agent(30_000);
  await watch.onTurnEnded(turn("a1", [user, reply, user, compacted]));
  agents.a1 = agent(160_000);
  await watch.onTurnEnded(turn("a1", [user, reply, user, compacted, user, reply]));

  assert.deepEqual(
    rows.map((r) => [r.event, r.used, r.preTokens ?? r.level ?? null]),
    [
      ["turn", 160_000, null],
      ["warning", 160_000, "red"],
      ["compact.native", 30_000, 160_000],
      ["turn", 30_000, null],
      ["turn", 160_000, null],
      ["warning", 160_000, "red"],
    ],
  );
});

test("onTurnEnded: a sharp drop with no compaction item writes compact.inferred", async () => {
  const agents = { a1: agent(130_000) };
  const { port, rows } = fakePort(agents);
  const watch = createContextWatch(port);
  await watch.onTurnEnded(turn("a1", [user, reply]));
  agents.a1 = agent(40_000);
  await watch.onTurnEnded(turn("a1", [user, reply, user, reply]));

  const inferred = rows.filter((r) => r.event === "compact.inferred");
  assert.equal(inferred.length, 1);
  assert.equal(inferred[0].preTokens, 130_000);
  assert.equal(inferred[0].used, 40_000);
});

test("onTurnEnded: a compaction item already seen is not counted again", async () => {
  const agents = { a1: agent(30_000) };
  const { port, rows } = fakePort(agents);
  const watch = createContextWatch(port);
  await watch.onTurnEnded(turn("a1", [user, compacted]));
  agents.a1 = agent(35_000);
  await watch.onTurnEnded(turn("a1", [user, compacted, user, reply]));

  assert.equal(rows.filter((r) => r.event === "compact.native").length, 1);
});

test("onTurnEnded: on first sight, a compaction before the last user message is not counted", async () => {
  const { port, rows } = fakePort({ a1: agent(30_000) });
  await createContextWatch(port).onTurnEnded(turn("a1", [user, compacted, user, reply]));

  assert.deepEqual(
    rows.map((r) => r.event),
    ["turn"],
  );
});

test("act compact: a native session gets /compact with the keep-list", async () => {
  const { port, sent, rows } = fakePort({ a1: agent(120_000) });
  const result = await createContextWatch(port).act({ agentId: "a1", action: "compact" });

  assert.deepEqual(result, { ok: true, error: null, agentId: "a1" });
  assert.deepEqual(sent, [["a1", "/compact Keep: .harness/state.md, files changed this session, failing tests and their output."]]);
  // The compact.native row comes from the next turn end, which sees the compaction item.
  assert.deepEqual(rows, []);
});

test("act compact: a loop agent's keep-list adds its step and story", async () => {
  const { port, sent } = fakePort({ a1: agent(120_000, { "loop-step": "implement", "loop-story": "S2" }) });
  await createContextWatch(port).act({ agentId: "a1", action: "compact" });

  assert.equal(
    sent[0][1],
    "/compact Keep: .harness/state.md, files changed this session, failing tests and their output, step implement, story S2.",
  );
});

test("act remind: writes a remind row and waits for red", async () => {
  const agents = { a1: agent(90_000) };
  const { port, rows } = fakePort(agents);
  const watch = createContextWatch(port);
  await watch.onTurnEnded(turn("a1"));
  assert.deepEqual(await watch.act({ agentId: "a1", action: "remind" }), { ok: true, error: null, agentId: "a1" });
  agents.a1 = agent(120_000);
  await watch.onTurnEnded(turn("a1"));
  agents.a1 = agent(155_000);
  await watch.onTurnEnded(turn("a1"));

  assert.deepEqual(
    rows.map((r) => [r.event, r.level ?? null]),
    [
      ["turn", null],
      ["remind", null],
      ["turn", null],
      ["turn", null],
      ["warning", "red"],
    ],
  );
  assert.equal(rows[1].used, 90_000);
});

test("act ignore: writes an ignore row and silences warnings", async () => {
  const agents = { a1: agent(90_000) };
  const { port, rows } = fakePort(agents);
  const watch = createContextWatch(port);
  await watch.onTurnEnded(turn("a1"));
  await watch.act({ agentId: "a1", action: "ignore" });
  agents.a1 = agent(160_000);
  await watch.onTurnEnded(turn("a1"));

  assert.deepEqual(
    rows.map((r) => r.event),
    ["turn", "ignore", "turn"],
  );
});

test("act compact on a session without /compact runs the fresh adapter", async () => {
  const { port, sent, fresh } = fakePort({ a2: agent(120_000, {}, ["review"]) });
  const result = await createContextWatch(port).act({ agentId: "a2", action: "compact" });

  assert.deepEqual(result, { ok: true, error: null, agentId: "f1" });
  assert.deepEqual(fresh, ["handoff a2", "create a2", "archive a2"]);
  assert.deepEqual(sent, []);
});

test("act fresh on a native session runs the fresh adapter and returns the new id", async () => {
  const { port, sent, fresh } = fakePort({ a1: agent(120_000) });
  const result = await createContextWatch(port).act({ agentId: "a1", action: "fresh" });

  assert.deepEqual(result, { ok: true, error: null, agentId: "f1" });
  assert.deepEqual(fresh, ["handoff a1", "create a1", "archive a1"]);
  assert.deepEqual(sent, []);
});

test("act fresh: a second press while the session is handing over is refused", async () => {
  const { port, fresh, holdHandoff } = fakePort({ a1: agent(120_000) });
  let release = () => {};
  holdHandoff(new Promise<void>((done) => (release = done)));
  const watch = createContextWatch(port);

  const first = watch.act({ agentId: "a1", action: "fresh" });
  const second = await watch.act({ agentId: "a1", action: "fresh" });
  release();

  assert.deepEqual(second, { ok: false, error: "That session is already starting fresh.", agentId: null });
  assert.deepEqual(await first, { ok: true, error: null, agentId: "f1" });
  assert.deepEqual(fresh, ["handoff a1", "create a1", "archive a1"]);
});

test("act fresh: a failed fresh compact returns its error", async () => {
  const { port } = fakePort({ a1: agent(120_000) });
  port.fresh.create = async () => {
    throw new Error("create failed");
  };

  assert.deepEqual(await createContextWatch(port).act({ agentId: "a1", action: "fresh" }), {
    ok: false,
    error: "create failed",
    agentId: null,
  });
});

test("the new session's first turn end writes compact.fresh with the old used as preTokens", async () => {
  const agents: Record<string, WatchAgent> = { a1: agent(130_000, { "loop-step": "implement" }) };
  const { port, rows } = fakePort(agents);
  const watch = createContextWatch(port);
  await watch.onTurnEnded(turn("a1"));
  await watch.act({ agentId: "a1", action: "fresh" });
  agents.f1 = agent(20_000, { "loop-step": "implement", "context-from": "a1" });
  await watch.onTurnEnded(turn("f1", [user, reply]));
  agents.f1 = agent(25_000, { "loop-step": "implement", "context-from": "a1" });
  await watch.onTurnEnded(turn("f1", [user, reply, user, reply]));

  assert.deepEqual(
    rows.map((r) => [r.agentId, r.event, r.used, r.preTokens ?? r.level ?? null]),
    [
      ["a1", "turn", 130_000, null],
      ["a1", "warning", 130_000, "amber"],
      ["f1", "compact.fresh", 20_000, 130_000],
      ["f1", "turn", 20_000, null],
      ["f1", "turn", 25_000, null],
    ],
  );
  assert.equal(rows[2].step, "implement");
});

test("act before any turn end still treats the first turn end as first sight", async () => {
  const { port, rows } = fakePort({ a1: agent(30_000) });
  const watch = createContextWatch(port);
  await watch.act({ agentId: "a1", action: "remind" });
  await watch.onTurnEnded(turn("a1", [user, compacted, user, reply]));

  assert.deepEqual(
    rows.map((r) => r.event),
    ["remind", "turn"],
  );
});

test("sessions: a seen agent's stored reading and memory, an unseen one read on demand, a gone one null", async () => {
  const agents = { a: agent(160_000), new: agent(40_000, {}, []) };
  const { port } = fakePort(agents);
  const watch = createContextWatch(port);
  await watch.onTurnEnded(turn("a"));
  await watch.act({ agentId: "a", action: "remind" });
  // The stored reading is from the last turn end, not a fresh read.
  agents.a = agent(170_000);

  assert.deepEqual(await watch.sessions(["a", "new", "gone"]), [
    {
      agentId: "a",
      reading: { used: 160_000, max: 200_000, level: "red", capability: "full", strategy: "native" },
      warned: ["red"],
      mode: "remind",
      red: 150_000,
    },
    {
      agentId: "new",
      reading: { used: 40_000, max: 200_000, level: "ok", capability: "partial", strategy: "fresh" },
      warned: [],
      mode: "normal",
      red: 150_000,
    },
    null,
  ]);
});

test("sessions: waits for that agent's in-flight turn end, so a new warning is not missed", async () => {
  const { port } = fakePort({ a: agent(120_000) });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const record = port.record;
  port.record = async (row) => {
    await gate;
    await record(row);
  };
  const watch = createContextWatch(port);
  const turnEnd = watch.onTurnEnded(turn("a"));
  const status = watch.sessions(["a"]);
  release();
  await turnEnd;

  const [result] = await status;
  assert.deepEqual(result?.warned, ["amber"]);
  assert.equal(result?.reading.used, 120_000);
});

const tool = (output: string): Item => ({ type: "tool_call", status: "completed", detail: { type: "shell", output } });

test("live: a seen agent's stored reading, its labels and split inputs from the first turn on", async () => {
  const labels = { "loop-step": "implement", "loop-story": "S11" };
  const agents = { a: agent(20_000, labels) };
  const { port } = fakePort(agents);
  const watch = createContextWatch(port);
  // The first turn's tool output is inside the first reading, so it does not count as tool chars.
  await watch.onTurnEnded(turn("a", [user, tool("x".repeat(400)), reply]));

  assert.deepEqual(await watch.live("a"), {
    agentId: "a",
    reading: { used: 20_000, max: 200_000, level: "ok", capability: "full", strategy: "native" },
    labels,
    split: { system: 20_000, toolChars: 0 },
  });

  agents.a = agent(30_000, labels);
  await watch.onTurnEnded(
    turn("a", [user, tool("x".repeat(400)), reply, user, tool("y".repeat(100)), tool("z".repeat(50)), reply]),
  );
  agents.a = agent(35_000, labels);
  await watch.onTurnEnded(
    turn("a", [user, tool("x".repeat(400)), reply, user, tool("y".repeat(100)), tool("z".repeat(50)), reply, user, tool("w".repeat(10))]),
  );
  // The stored reading is from the last turn end, not a fresh read.
  agents.a = agent(90_000, labels);

  const live = await watch.live("a");
  assert.equal(live?.reading.used, 35_000);
  assert.deepEqual(live?.split, { system: 20_000, toolChars: 160 });
});

test("live: split goes null after a compaction and stays null", async () => {
  const agents = { a: agent(120_000) };
  const { port } = fakePort(agents);
  const watch = createContextWatch(port);
  await watch.onTurnEnded(turn("a", [user, reply]));
  agents.a = agent(30_000);
  await watch.onTurnEnded(turn("a", [user, reply, user, compacted]));
  assert.equal((await watch.live("a"))?.split, null);

  agents.a = agent(40_000);
  await watch.onTurnEnded(turn("a", [user, reply, user, compacted, user, tool("x"), reply]));
  assert.equal((await watch.live("a"))?.split, null);
});

test("live: split is null when the watch first sees a session after its first turn", async () => {
  const agents = { a: agent(50_000) };
  const { port } = fakePort(agents);
  const watch = createContextWatch(port);
  await watch.onTurnEnded(turn("a", [user, reply, user, reply]));
  agents.a = agent(55_000);
  await watch.onTurnEnded(turn("a", [user, reply, user, reply, user, tool("x"), reply]));

  assert.equal((await watch.live("a"))?.split, null);
});

test("live: an unseen agent is read now with a null split; a gone one is null", async () => {
  const agents: Record<string, WatchAgent> = { a: agent(40_000), new: agent(40_000, { "loop-step": "plan" }, []) };
  const { port } = fakePort(agents);
  const watch = createContextWatch(port);
  await watch.onTurnEnded(turn("a", [user, reply]));
  delete agents.a;

  assert.deepEqual(await watch.live("new"), {
    agentId: "new",
    reading: { used: 40_000, max: 200_000, level: "ok", capability: "partial", strategy: "fresh" },
    labels: { "loop-step": "plan" },
    split: null,
  });
  assert.equal(await watch.live("a"), null);
  assert.equal(await watch.live("gone"), null);
});

test("live: split goes null when the timeline is replaced by a shorter one", async () => {
  const agents = { a: agent(20_000) };
  const { port } = fakePort(agents);
  const watch = createContextWatch(port);
  await watch.onTurnEnded(turn("a", [user, reply]));
  agents.a = agent(25_000);
  await watch.onTurnEnded(turn("a", [user]));

  assert.equal((await watch.live("a"))?.split, null);
});

const readOf = (filePath: string, content: string): Item => ({
  type: "tool_call",
  status: "completed",
  detail: { type: "read", filePath, content },
});
const editOf = (filePath: string): Item => ({
  type: "tool_call",
  status: "completed",
  detail: { type: "edit", filePath, newString: "x" },
});

test("explore: a loop agent's count runs across turns, then freezes at its first code edit", async () => {
  const agents = { a: agent(20_000, { "loop-step": "implement" }) };
  const { port, rows } = fakePort(agents);
  const watch = createContextWatch(port);
  const first = [user, readOf("a.ts", "12345")];
  await watch.onTurnEnded(turn("a", first));
  const second = [...first, readOf("b.ts", "123"), editOf("src/b.ts")];
  await watch.onTurnEnded(turn("a", second));
  await watch.onTurnEnded(turn("a", [...second, readOf("c.ts", "1234567890")]));

  assert.deepEqual(
    rows.filter((r) => r.event === "turn").map((r) => r.explore),
    [
      { reads: 1, searches: 0, files: 1, chars: 5, edited: false },
      { reads: 2, searches: 0, files: 2, chars: 8, edited: true },
      { reads: 2, searches: 0, files: 2, chars: 8, edited: true },
    ],
  );
});

test("explore: an agent without a loop-step label has no explore field, and neither do other events", async () => {
  const agents = { a: agent(120_000), b: agent(120_000, { "loop-step": "plan" }) };
  const { port, rows } = fakePort(agents);
  const watch = createContextWatch(port);
  await watch.onTurnEnded(turn("a", [user, readOf("a.ts", "x")]));
  await watch.onTurnEnded(turn("b", [user, readOf("a.ts", "x")]));

  assert.equal("explore" in rows.find((r) => r.agentId === "a" && r.event === "turn")!, false);
  assert.deepEqual(
    rows.filter((r) => r.agentId === "b").map((r) => [r.event, "explore" in r]),
    [
      ["turn", true],
      ["warning", false],
    ],
  );
});

test("explore: a replay agent's turn rows are counted by its replay-step label while step stays null", async () => {
  const agents = { a: agent(20_000, { "replay-step": "review" }) };
  const { port, rows } = fakePort(agents);
  const watch = createContextWatch(port);
  await watch.onTurnEnded(turn("a", [user, readOf("a.ts", "12345")]));

  const turns = rows.filter((r) => r.event === "turn");
  assert.equal(turns[0].step, null);
  assert.deepEqual(turns[0].explore, { reads: 1, searches: 0, files: 1, chars: 5, edited: false });
});

test("explore: first sight mid-session records null from then on", async () => {
  const agents = { a: agent(20_000, { "loop-step": "implement" }) };
  const { port, rows } = fakePort(agents);
  const watch = createContextWatch(port);
  const seen = [user, readOf("a.ts", "x"), reply, user, readOf("b.ts", "y")];
  await watch.onTurnEnded(turn("a", seen));
  await watch.onTurnEnded(turn("a", [...seen, readOf("c.ts", "z")]));

  assert.deepEqual(
    rows.filter((r) => r.event === "turn").map((r) => r.explore),
    [null, null],
  );
});

test("explore: a timeline replaced by a shorter one records null from then on", async () => {
  const agents = { a: agent(20_000, { "loop-step": "implement" }) };
  const { port, rows } = fakePort(agents);
  const watch = createContextWatch(port);
  await watch.onTurnEnded(turn("a", [user, readOf("a.ts", "x"), readOf("b.ts", "y")]));
  await watch.onTurnEnded(turn("a", [user]));
  await watch.onTurnEnded(turn("a", [user, readOf("c.ts", "z")]));

  assert.deepEqual(
    rows.filter((r) => r.event === "turn").map((r) => r.explore),
    [{ reads: 2, searches: 0, files: 2, chars: 2, edited: false }, null, null],
  );
});
