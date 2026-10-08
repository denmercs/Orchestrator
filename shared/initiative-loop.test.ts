import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LOOP_CONFIG, initiativeLoopSettings, PROFILE_STEPS } from "./initiative-loop";

const emptyProfiles = { plan: "", implement: "", review: "", fix: "" };

test("loop settings default every step profile to empty (Auto)", () => {
  assert.deepEqual(DEFAULT_LOOP_CONFIG.profiles, emptyProfiles);
  assert.deepEqual(PROFILE_STEPS, ["plan", "implement", "review", "fix"]);
});

test("stored loop settings without profiles or maxRetries still parse, with the defaults", () => {
  const parsed = initiativeLoopSettings.schema.parse({ parallel: 2, reviewRounds: 3, maxFixes: 3 });
  assert.deepEqual(parsed, { parallel: 2, reviewRounds: 3, maxFixes: 3, maxRetries: 2, profiles: emptyProfiles });
});
