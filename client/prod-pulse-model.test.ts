import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProdPulse } from "../shared/orchestration";
import { pulseTabState } from "./prod-pulse-model";

function pulse(rest: Partial<ProdPulse> = {}): ProdPulse {
  return {
    available: true,
    error: null,
    dashboardUrl: null,
    outcome: "health",
    checkedAt: "2026-10-08T12:00:00Z",
    changedAt: null,
    failReason: null,
    stale: false,
    systemNotes: [],
    cards: [],
    issues: [],
    older: [],
    actions: [],
    ...rest,
  };
}

test("pulseTabState is loading until the first fetch settles", () => {
  assert.deepEqual(pulseTabState({ pulse: null, loaded: false }), { kind: "loading" });
});

test("pulseTabState says it couldn't load when the fetch settled with no data", () => {
  assert.deepEqual(pulseTabState({ pulse: null, loaded: true }), {
    kind: "empty",
    text: "Couldn't load prod pulse.",
  });
});

test("pulseTabState says prod pulse isn't set up when it is unavailable", () => {
  assert.deepEqual(pulseTabState({ pulse: pulse({ available: false }), loaded: true }), {
    kind: "empty",
    text: "Prod pulse isn't set up.",
  });
});

test("pulseTabState is ready with the pulse when it is available", () => {
  const ready = pulse();
  assert.deepEqual(pulseTabState({ pulse: ready, loaded: true }), { kind: "ready", pulse: ready });
});
