import assert from "node:assert/strict";
import test from "node:test";
import { ROUND_NUDGE_AT, roundNudgeLine, shouldRoundNudge } from "./round-nudge";

test("shouldRoundNudge: loop review at rounds 1 and 2 never nudge; round 3 does once", () => {
  assert.equal(shouldRoundNudge("review", 1, {}, false), false);
  assert.equal(shouldRoundNudge("review", 2, {}, false), false);
  assert.equal(shouldRoundNudge("review", 3, {}, false), true);
  assert.equal(shouldRoundNudge("review", 3, { round_nudged: String(ROUND_NUDGE_AT) }, false), false);
});

test("shouldRoundNudge: loop implement at round 3 nudges; rounds 1 and 2 do not", () => {
  assert.equal(shouldRoundNudge("implement", 1, {}, false), false);
  assert.equal(shouldRoundNudge("implement", 2, {}, false), false);
  assert.equal(shouldRoundNudge("implement", 3, {}, false), true);
  assert.equal(shouldRoundNudge("implement", 3, { round_nudged: "3" }, false), false);
});

test("shouldRoundNudge: factory slices use review_round, not QA story round", () => {
  assert.equal(shouldRoundNudge("review", 3, { review_round: "1" }, true), false);
  assert.equal(shouldRoundNudge("review", 1, { review_round: "3" }, true), true);
  assert.equal(shouldRoundNudge("implement", 4, { review_round: "3" }, true), true);
  assert.equal(shouldRoundNudge("implement", 3, { review_round: "1" }, true), false);
});

test("roundNudgeLine names the story", () => {
  assert.equal(roundNudgeLine("S4"), "S4 is on round 3; the cap on rounds and spend is near.");
  assert.equal(roundNudgeLine("S4", "Churn alert"), "S4 (Churn alert) is on round 3; the cap on rounds and spend is near.");
});
