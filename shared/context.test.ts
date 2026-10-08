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
