import assert from "node:assert/strict";
import { test } from "node:test";
import { inHoldWindow, usageLimitResumeAt } from "./usage-limit";

const at = (hour: number, minute = 0) => new Date(2026, 9, 9, hour, minute);

test("a message that isn't a plan limit gives no resume time, including a transient rate limit", () => {
  assert.equal(usageLimitResumeAt("rate limited", at(1)), null);
  assert.equal(usageLimitResumeAt("provider crashed", at(1)), null);
});

test("a reset time in epoch seconds is used, two minutes late", () => {
  const resume = usageLimitResumeAt("Claude AI usage limit reached|1760000000", at(1));
  assert.equal(resume?.getTime(), 1760000000 * 1000 + 120_000);
});

test("a clock reset time is the next occurrence in local time, two minutes late", () => {
  const resume = usageLimitResumeAt("You've hit your limit · resets 3am (America/Chicago)", at(1));
  assert.deepEqual(resume, new Date(2026, 9, 9, 3, 2));
  const later = usageLimitResumeAt("You've hit your session limit · resets 3:30pm", at(16));
  assert.deepEqual(later, new Date(2026, 9, 10, 15, 32));
  assert.deepEqual(usageLimitResumeAt("usage limit reached, resets 12am", at(23)), new Date(2026, 9, 10, 0, 2));
});

test("a plan limit with no readable reset time waits an hour", () => {
  assert.deepEqual(usageLimitResumeAt("Usage limit reached", at(1)), at(2));
});

test("the hold window may wrap midnight and is off unless both ends are set", () => {
  assert.equal(inHoldWindow(6, 22, at(5)), false);
  assert.equal(inHoldWindow(6, 22, at(6)), true);
  assert.equal(inHoldWindow(6, 22, at(21, 59)), true);
  assert.equal(inHoldWindow(6, 22, at(22)), false);
  assert.equal(inHoldWindow(22, 6, at(23)), true);
  assert.equal(inHoldWindow(22, 6, at(7)), false);
  assert.equal(inHoldWindow(6, null, at(12)), false);
  assert.equal(inHoldWindow(null, null, at(12)), false);
});
