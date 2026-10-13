import type { ProviderUsage } from "../shared/plan-usage";

// Claude's plan limit (the 5-hour session or a weekly one), as opposed to a transient rate limit:
// a failed turn that says this will keep failing until the limit resets, so retrying is pointless.
const LIMIT = /usage limit|hit your (?:[a-z]+ )?limit|limit reached/i;
// Claude Code's own notice, which is the whole reply when it stops a turn on the plan limit: either
// `Claude AI usage limit reached|<epoch>` or `You've hit your [session|weekly|...] limit · resets ...`.
const NOTICE = /^(?:you[\u2019']ve hit your (?:[a-z]+ )?limit|claude ai usage limit reached)/i;
// The notice is short; a longer reply that happens to mention a limit is the agent talking.
const NOTICE_MAX_CHARS = 200;
// Used when the message names no reset time.
const FALLBACK_MS = 60 * 60 * 1000;
// A little past the reset, so the first try doesn't land on the boundary.
const BUFFER_MS = 2 * 60 * 1000;

// When a failed turn's message says the plan limit was hit: the moment to try again. Null when it
// isn't a plan limit. The reset time is read from the message in either form Claude Code uses:
// `...limit reached|1760000000` (epoch seconds) or `...limit · resets 3am (America/Chicago)`,
// taken in the host's own time zone. Without either, it is an hour from now.
export function usageLimitResumeAt(message: string, now: Date): Date | null {
  if (!LIMIT.test(message)) return null;
  const epoch = /\|\s*(\d{9,11})\b/.exec(message);
  if (epoch) return new Date(Number(epoch[1]) * 1000 + BUFFER_MS);
  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(message);
  if (clock) {
    const hour = (Number(clock[1]) % 12) + (clock[3].toLowerCase() === "pm" ? 12 : 0);
    const reset = new Date(now);
    reset.setHours(hour, Number(clock[2] ?? 0), 0, 0);
    if (reset.getTime() <= now.getTime()) reset.setDate(reset.getDate() + 1);
    return new Date(reset.getTime() + BUFFER_MS);
  }
  return new Date(now.getTime() + FALLBACK_MS);
}

// When a turn's final reply is Claude Code's plan-limit notice itself: the moment to try again, read
// the same way as for a failed turn. Null for any other reply, including one that only discusses a
// limit ("retry limit reached", a summary that mentions the usage limit).
export function limitNotice(text: string, now: Date): Date | null {
  const trimmed = text.trim();
  if (trimmed.length > NOTICE_MAX_CHARS || !NOTICE.test(trimmed)) return null;
  return usageLimitResumeAt(trimmed, now);
}

// A plan window this full (used %) counts as the limit: the next turn would hit it.
export const PLAN_LIMIT_PCT = 99;

// When a provider's live plan usage says it is at its limit: the moment to try again. Null unless it
// is available and some window is at PLAN_LIMIT_PCT. The latest reset among those windows, a little
// past it; an hour from now when none of them names a reset still ahead.
export function planLimitUntil(usage: ProviderUsage, now: Date): Date | null {
  if (usage.status !== "available") return null;
  const full = usage.windows.filter((window) => (window.usedPct ?? 0) >= PLAN_LIMIT_PCT);
  if (!full.length) return null;
  const resets = full
    .map((window) => Date.parse(window.resetsAt ?? ""))
    .filter((time) => time > now.getTime());
  if (!resets.length) return new Date(now.getTime() + FALLBACK_MS);
  return new Date(Math.max(...resets) + BUFFER_MS);
}

// Whether `now` falls in the hold window [from, until) of local hours, which may wrap midnight
// (from 6, until 22 holds all day and leaves the night free). Off unless both ends are set.
export function inHoldWindow(from: number | null, until: number | null, now: Date): boolean {
  if (from === null || until === null || from === until) return false;
  const hour = now.getHours();
  return from < until ? hour >= from && hour < until : hour >= from || hour < until;
}
