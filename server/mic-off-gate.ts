// The server's view of voice.micOff (Ignore me). Fails closed only in the short window before the saved value is known;
// a setting that is unreadable (invalid, or a read that keeps failing) fails open, so speech goes through as for a
// default user, and `unreadable()` lets the drawer say so.
export const MIC_OFF_MAX_MISSES = 3;

type SettingsState = { status: string; values?: { micOff?: boolean } };

export function createMicOffGate(read: () => Promise<SettingsState>) {
  let micOff: boolean | null = null;
  let unreadable = false;
  let misses = 0;
  const sync = (state: SettingsState) => {
    if (state.status === "ready") {
      micOff = state.values?.micOff === true;
      unreadable = false;
      misses = 0;
    } else if (state.status === "loading") {
      // No answer yet: keep what we know.
    } else {
      micOff = false;
      unreadable = true;
    }
  };
  return {
    sync,
    unreadable: () => unreadable,
    async muted(): Promise<boolean> {
      if (micOff !== null) return micOff;
      try {
        sync(await read());
      } catch {
        // Counted below.
      }
      if (micOff !== null) return micOff;
      misses += 1;
      if (misses >= MIC_OFF_MAX_MISSES) {
        micOff = false;
        unreadable = true;
      }
      return micOff ?? true;
    },
  };
}
