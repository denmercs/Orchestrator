import assert from "node:assert/strict";
import { test } from "node:test";
import { listLine, noSessionLine, pickFirstLine, sentLine, spokenLine, whichLine } from "./voice-lines";

test("numbered lines: the session list, pick-first, did-you-mean and no-match all end in how to answer", () => {
  assert.equal(listLine(["Phase 1 architecture", "Check"]), "One, Phase 1 architecture. Two, Check. Say a number, or switch to and a name.");
  assert.equal(listLine(["a", "b"], 5), "One, a. Two, b. And more. Say a number, or switch to and a name.");
  assert.equal(listLine([]), "No sessions are open.");
  assert.equal(pickFirstLine(["a", "b"]), "Pick a session first. One, a. Two, b. Say a number, or switch to and a name.");
  assert.equal(pickFirstLine([]), "Pick a session first. No sessions are open.");
  assert.equal(whichLine(["S4 Plan", "S6 Plan"]), "Did you mean: one, S4 Plan; two, S6 Plan? Say a number.");
  assert.equal(noSessionLine("billing"), "No session called billing.");
  assert.equal(noSessionLine("billing", ["a"]), "No session called billing. One, a. Say a number, or switch to and a name.");
});

test("lines are whole sentences, and replies are spoken as their first plain paragraph", () => {
  assert.equal(sentLine("docs"), "Sent to docs.");
  assert.equal(spokenLine("```ts\nx\n```\n**Done**, see `a.ts`.\n\nMore."), "Done, see a.ts.");
});
