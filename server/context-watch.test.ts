import assert from "node:assert/strict";
import { test } from "node:test";
import type { TelemetryRow } from "./context-telemetry";
import { createContextWatch, type TurnEnded, type WatchAgent, type WatchPort } from "./context-watch";

type Item = TurnEnded["timeline"][number];

// A fake port: agents are set per test, and every row and sent message is captured.
function fakePort(agents: Record<string, WatchAgent>) {
  const rows: TelemetryRow[] = [];
  const sent: [string, string][] = [];
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
  };
  return { port, rows, sent };
}

function agent(used: number | null, labels: Record<string, string> = {}, commands = ["compact"]): WatchAgent {
  return {
    usage: used === null ? null : { contextWindowUsedTokens: used, contextWindowMaxTokens: 200_000 },
    commands: commands.map((name) => ({ name })),
    labels,
  };
}

function turn(id: string, timeline: Item[] = []): TurnEnded {
  return { agent: { id, provider: "claude" }, timeline };
}

test("onTurnEnded: one turn end writes one turn row with provider and step", async () => {
  const { port, rows } = fakePort({ a1: agent(40_000, { "loop-step": "implement", "loop-story": "S2" }) });
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
    },
  ]);
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

test("act fresh, or compact on a fresh-strategy session, is not available yet", async () => {
  const { port, sent } = fakePort({ a1: agent(120_000), a2: agent(120_000, {}, ["review"]) });
  const watch = createContextWatch(port);

  assert.deepEqual(await watch.act({ agentId: "a1", action: "fresh" }), {
    ok: false,
    error: "Start fresh arrives in S3",
    agentId: null,
  });
  assert.equal((await watch.act({ agentId: "a2", action: "compact" })).ok, false);
  assert.deepEqual(sent, []);
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
