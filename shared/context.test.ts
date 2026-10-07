import assert from "node:assert/strict";
import { test } from "node:test";
import { contextAct, contextSettings, contextSummaryRpc } from "./context";

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
