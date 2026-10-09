// Claude's plan limit (the 5-hour session or a weekly one), as opposed to a transient rate limit:
// a failed turn that says this will keep failing until the limit resets, so retrying is pointless.
const LIMIT = /usage limit|hit your (?:[a-z]+ )?limit|limit reached/i;
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

// Whether `now` falls in the hold window [from, until) of local hours, which may wrap midnight
// (from 6, until 22 holds all day and leaves the night free). Off unless both ends are set.
export function inHoldWindow(from: number | null, until: number | null, now: Date): boolean {
  if (from === null || until === null || from === until) return false;
  const hour = now.getHours();
  return from < until ? hour >= from && hour < until : hour >= from || hour < until;
}
