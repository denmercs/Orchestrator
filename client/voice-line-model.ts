// Which `voice-line` items the phone speaks: pure, no React or Paseo imports. A timeline item mounts again whenever it
// scrolls into view, so a line plays once per lineId and never for an item older than this load.
const REMEMBERED_LINES = 200;

export function createLineGate(mountedAt: number) {
  const seen = new Set<string>();
  return {
    // True the first time a fresh line is claimed; false for a line already claimed or from before `mountedAt`.
    claim(lineId: string, timestamp: number): boolean {
      if (timestamp < mountedAt || seen.has(lineId)) return false;
      seen.add(lineId);
      if (seen.size > REMEMBERED_LINES) seen.delete(seen.values().next().value as string);
      return true;
    },
  };
}

// The Mac's Voice drawer speaks for itself (and goes quiet while the phone is active), so the renderer plays on a phone only.
export function shouldSpeakHere(platform: "ios" | "android" | "web"): boolean {
  return platform !== "web";
}
