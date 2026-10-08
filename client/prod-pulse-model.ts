import type { ProdPulse } from "../shared/orchestration";

export type PulseTabState =
  | { kind: "loading" }
  | { kind: "empty"; text: string }
  | { kind: "ready"; pulse: ProdPulse };

// What the Pulse tab body shows: a skeleton until the first fetch settles, one muted
// line when there is nothing to show, otherwise the panel.
export function pulseTabState({ pulse, loaded }: { pulse: ProdPulse | null; loaded: boolean }): PulseTabState {
  if (!loaded) {
    return { kind: "loading" };
  }
  if (!pulse) {
    return { kind: "empty", text: "Couldn't load prod pulse." };
  }
  if (!pulse.available) {
    return { kind: "empty", text: "Prod pulse isn't set up." };
  }
  return { kind: "ready", pulse };
}
