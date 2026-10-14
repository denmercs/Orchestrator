// The server's view of voice.micOff (Ignore me). It remembers the last value actually read and keeps using it through any
// glitch (a rejected read, a loading state, a later invalid one). It fails closed (speech is dropped) while no value has
// ever been read, rereading with a backoff; it fails open (the default, mic on) only when nothing was ever read and the
// stored value is definitively invalid. `unreadable()` lets the drawer say so; `checking()` says the value isn't known yet.
export const MIC_OFF_RETRY_MS = 250;
const MAX_RETRY_MS = 8_000;

type Timer = { stop(): void };
const realSchedule = (fn: () => void, ms: number): Timer => {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return { stop: () => clearTimeout(handle) };
};

type SettingsState = { status: string; values?: { micOff?: boolean } };

export function createMicOffGate(read: () => Promise<SettingsState>, now: () => number = Date.now, schedule: (fn: () => void, ms: number) => Timer = realSchedule) {
  let lastKnown: boolean | null = null;
  let unreadable = false;
  let misses = 0;
  let nextTryAt = 0;
  let pending: Timer | null = null;
  let stopped = false;
  const backoff = () => Math.min(MIC_OFF_RETRY_MS * 2 ** (misses - 1), MAX_RETRY_MS);
  const sync = (state: SettingsState) => {
    if (state.status === "ready") {
      lastKnown = state.values?.micOff === true;
      unreadable = false;
      misses = 0;
    } else if (state.status === "invalid") {
      unreadable = true;
      if (lastKnown === null) lastKnown = false;
    }
    // Anything else (loading, error) is no answer: keep what we know.
  };
  // The startup read: if it fails, keep rereading (same backoff) until a value arrives, so Ignore me doesn't wait for a spoken turn.
  async function tryRead(): Promise<void> {
    pending = null;
    if (stopped || lastKnown !== null) return;
    try {
      sync(await read());
    } catch {
      // Retried below.
    }
    if (lastKnown !== null || stopped) return;
    misses += 1;
    nextTryAt = now() + backoff();
    pending = schedule(() => void tryRead(), backoff());
  }
  return {
    start: tryRead,
    stop() {
      stopped = true;
      pending?.stop();
    },
    sync,
    unreadable: () => unreadable,
    lastKnown: () => lastKnown,
    /** No value has been read yet, so speech is held. */
    checking: () => lastKnown === null,
    async muted(): Promise<boolean> {
      if (lastKnown !== null) return lastKnown;
      if (now() < nextTryAt) return true;
      try {
        sync(await read());
      } catch {
        // Retried after the backoff.
      }
      if (lastKnown !== null) return lastKnown;
      misses += 1;
      nextTryAt = now() + backoff();
      return true;
    },
  };
}
