import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderUsage } from "../shared/plan-usage";
import { PLAN_LIMIT_PCT, inHoldWindow, planLimitUntil, usageLimitResumeAt } from "./usage-limit";

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

const usage = (windows: { usedPct?: number | null; resetsAt?: string | null }[], status: ProviderUsage["status"] = "available"): ProviderUsage => ({
  providerId: "claude",
  status,
  planLabel: null,
  windows: windows.map((window, i) => ({ id: `w${i}`, label: `Window ${i}`, ...window })),
});

test("a provider under the limit, or not available, is not limited", () => {
  assert.equal(planLimitUntil(usage([{ usedPct: PLAN_LIMIT_PCT - 1, resetsAt: at(3).toISOString() }]), at(1)), null);
  assert.equal(planLimitUntil(usage([{ usedPct: null }]), at(1)), null);
  assert.equal(planLimitUntil(usage([{ usedPct: 100, resetsAt: at(3).toISOString() }], "error"), at(1)), null);
  assert.equal(planLimitUntil(usage([]), at(1)), null);
});

test("a window at the limit holds until its reset, two minutes late; the latest one wins", () => {
  const until = planLimitUntil(
    usage([
      { usedPct: PLAN_LIMIT_PCT, resetsAt: at(3).toISOString() },
      { usedPct: 100, resetsAt: at(5).toISOString() },
      { usedPct: 10, resetsAt: at(9).toISOString() },
    ]),
    at(1),
  );
  assert.deepEqual(until, at(5, 2));
});

test("a window at the limit with no reset ahead holds for an hour", () => {
  assert.deepEqual(planLimitUntil(usage([{ usedPct: 100 }]), at(1)), at(2));
  assert.deepEqual(planLimitUntil(usage([{ usedPct: 100, resetsAt: at(0).toISOString() }]), at(1)), at(2));
});
