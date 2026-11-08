import assert from "node:assert/strict";
import test from "node:test";
import { ROUND_NUDGE_AT, roundNudgeDue, roundNudgeLine } from "./round-nudge";

test("roundNudgeDue: review rounds 1 and 2 are quiet; round 3 and later are due until nudged", () => {
  assert.equal(roundNudgeDue({}, 1), false);
  assert.equal(roundNudgeDue({}, 2), false);
  assert.equal(roundNudgeDue({}, 3), true);
  assert.equal(roundNudgeDue({}, 4), true);
  assert.equal(roundNudgeDue({ round_nudged: String(ROUND_NUDGE_AT) }, 3), false);
  assert.equal(roundNudgeDue({ round_nudged: String(ROUND_NUDGE_AT) }, 4), false);
});

test("roundNudgeLine names the story and the round", () => {
  assert.equal(
    roundNudgeLine("S4"),
    "S4 has reached review round 3; the cap on rounds and spend is near.",
  );
  assert.equal(
    roundNudgeLine("S4", "Churn alert", { spent: null, cap: 5 }),
    "S4 (Churn alert) has reached review round 3; the cap on rounds and spend is near.",
  );
});

test("roundNudgeLine shows spend against the cap when known and no money when not", () => {
  const known = roundNudgeLine("S10", "Nudge", { spent: 4.2, cap: 5 });
  assert.equal(known, "S10 (Nudge) has reached review round 3, $4.20 of $5 spent; the cap on rounds and spend is near.");
  assert.doesNotMatch(roundNudgeLine("S10", "Nudge", { spent: null, cap: 5 }), /\$/);
  assert.doesNotMatch(roundNudgeLine("S10", "Nudge"), /\$/);
});
