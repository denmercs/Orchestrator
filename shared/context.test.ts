import assert from "node:assert/strict";
import { test } from "node:test";
import { contextAct, contextSessionsRpc, contextSettings, contextSummaryRpc } from "./context";

test("context settings default to amber 100k and red 150k", () => {
  assert.deepEqual(contextSettings.schema.parse({}), { amber: 100_000, red: 150_000 });
});

test("context.act accepts the four actions and rejects anything else", () => {
  for (const action of ["compact", "fresh", "remind", "ignore"]) {
    assert.deepEqual(contextAct.input.parse({ agentId: "a1", action }), { agentId: "a1", action });
  }
  assert.equal(contextAct.input.safeParse({ agentId: "a1", action: "reset" }).success, false);
});

test("context.summary takes a null since", () => {
  assert.deepEqual(contextSummaryRpc.input.parse({ since: null }), { since: null });
});

test("context.summary takes an optional today for the spend windows", () => {
  const today = "2026-10-08T05:00:00.000Z";
  assert.deepEqual(contextSummaryRpc.input.parse({ since: "2026-10-01T00:00:00.000Z", today }), {
    since: "2026-10-01T00:00:00.000Z",
    today,
  });
  assert.deepEqual(contextSummaryRpc.input.parse({ since: null }), { since: null });
});

test("context.sessions takes agent ids and returns a status or null for each", () => {
  assert.deepEqual(contextSessionsRpc.input.parse({ agentIds: ["a1"] }), { agentIds: ["a1"] });
  const status = {
    agentId: "a1",
    reading: { used: null, max: null, level: "unknown", capability: "basic", strategy: "fresh" },
    warned: [],
    mode: "normal",
    red: 150_000,
  };
  assert.deepEqual(contextSessionsRpc.output.parse([status, null]), [status, null]);
  assert.equal(contextSessionsRpc.output.safeParse([{ ...status, mode: "snooze" }]).success, false);
});

test("context.summary rejects a today that is not an ISO date-time", () => {
  assert.equal(contextSummaryRpc.input.safeParse({ since: null, today: "nope" }).success, false);
  assert.equal(contextSummaryRpc.input.safeParse({ since: null, today: "2026-10-08T00:00:00-05:00" }).success, true);
});
