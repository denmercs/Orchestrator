import assert from "node:assert/strict";
import { test } from "node:test";
import { capLabel, MODE_LABEL, POLICY_STEPS, stepAct, stepCap, stepStuckTurns, stepWarn } from "./context-tab-model";

test("stepWarn: moves by 5 either way", () => {
  assert.equal(stepWarn({ warn: 70, act: 90 }, 1), 75);
  assert.equal(stepWarn({ warn: 70, act: 90 }, -1), 65);
});

test("stepWarn: clamps to 40 at the bottom", () => {
  assert.equal(stepWarn({ warn: 40, act: 90 }, -1), 40);
});

test("stepWarn: stays 5 below Act", () => {
  assert.equal(stepWarn({ warn: 85, act: 90 }, 1), 85);
  assert.equal(stepWarn({ warn: 80, act: 90 }, 1), 85);
});

test("stepWarn: pulls an off-grid value into range", () => {
  assert.equal(stepWarn({ warn: 63, act: 90 }, -1), 58);
  assert.equal(stepWarn({ warn: 20, act: 90 }, -1), 40);
});

test("stepAct: moves by 5 either way", () => {
  assert.equal(stepAct({ warn: 60, act: 85 }, 1), 90);
  assert.equal(stepAct({ warn: 60, act: 85 }, -1), 80);
});

test("stepAct: clamps to 95 at the top", () => {
  assert.equal(stepAct({ warn: 60, act: 95 }, 1), 95);
});

test("stepAct: stays 5 above Warn", () => {
  assert.equal(stepAct({ warn: 80, act: 85 }, -1), 85);
  assert.equal(stepAct({ warn: 75, act: 85 }, -1), 80);
});

test("stepAct: pulls an off-grid value into range", () => {
  assert.equal(stepAct({ warn: 60, act: 98 }, 1), 95);
  assert.equal(stepAct({ warn: 60, act: 97 }, -1), 92);
});

test("stepStuckTurns: moves by 1 and clamps to 3–30", () => {
  assert.equal(stepStuckTurns(8, 1), 9);
  assert.equal(stepStuckTurns(8, -1), 7);
  assert.equal(stepStuckTurns(3, -1), 3);
  assert.equal(stepStuckTurns(30, 1), 30);
});

test("stepCap: steps $1 with a $1 floor", () => {
  assert.equal(stepCap(5, 1), 6);
  assert.equal(stepCap(5, -1), 4);
  assert.equal(stepCap(1, -1), 1);
});

test("stepCap: a fractional cap steps from where it is", () => {
  assert.equal(stepCap(2.5, 1), 3.5);
  assert.equal(stepCap(2.5, -1), 1.5);
  assert.equal(stepCap(1.5, -1), 1);
});

test("capLabel: two decimals with a dollar sign", () => {
  assert.equal(capLabel(5), "$5.00");
  assert.equal(capLabel(2.5), "$2.50");
});

test("POLICY_STEPS: Plan, Implement, Review in that order with their settings keys", () => {
  assert.deepEqual(
    POLICY_STEPS.map((s) => [s.key, s.label]),
    [
      ["plan", "Plan"],
      ["implement", "Implement"],
      ["review", "Review"],
    ],
  );
});

test("POLICY_STEPS: only Review carries a note", () => {
  assert.deepEqual(
    POLICY_STEPS.filter((s) => s.note).map((s) => s.key),
    ["review"],
  );
});

test("MODE_LABEL: compact and fresh session", () => {
  assert.deepEqual(MODE_LABEL, { compact: "Compact", fresh: "Fresh session" });
});

test("stepWarn: plus never lowers Warn when a saved pair sits too close", () => {
  assert.equal(stepWarn({ warn: 88, act: 90 }, 1), 88);
  assert.equal(stepWarn({ warn: 95, act: 50 }, 1), 95);
});

test("stepAct: minus never raises Act when a saved pair sits too close", () => {
  assert.equal(stepAct({ warn: 40, act: 42 }, -1), 42);
  assert.equal(stepAct({ warn: 90, act: 50 }, -1), 50);
});
