import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LOOP_CONFIG, initiativeLoopSettings, PROFILE_STEPS } from "./initiative-loop";

const emptyProfiles = { plan: "", implement: "", review: "", fix: "" };

test("loop settings default every step profile to empty (Auto)", () => {
  assert.deepEqual(DEFAULT_LOOP_CONFIG.profiles, emptyProfiles);
  assert.deepEqual(PROFILE_STEPS, ["plan", "implement", "review", "fix"]);
});

test("stored loop settings without profiles still parse, with empty profiles", () => {
  const parsed = initiativeLoopSettings.schema.parse({ parallel: 2, reviewRounds: 3, maxFixes: 3 });
  assert.deepEqual(parsed, { parallel: 2, reviewRounds: 3, maxFixes: 3, profiles: emptyProfiles });
});
