// The Speak replies pill, as data. Kept free of React and the Paseo client so it can be tested on its own.
import type { SpeakMode } from "../shared/speak-replies";

export type SpeakPillView = { title: string; label: string; icon: "Volume2" | "VolumeX" };

const NEXT: Record<SpeakMode, SpeakMode> = { off: "short", short: "full", full: "off" };

/** What one press does: off → short → full → off. */
export const nextSpeakMode = (mode: SpeakMode): SpeakMode => NEXT[mode];

export function speakPill(mode: SpeakMode): SpeakPillView {
  if (mode === "short") {
    return { title: "The first line of each reply is spoken. Press to speak the full reply", label: "Speak · short", icon: "Volume2" };
  }
  if (mode === "full") {
    return { title: "Whole replies are spoken. Press to stop speaking them", label: "Speak · full", icon: "Volume2" };
  }
  return { title: "Speak this session's replies aloud", label: "Speak", icon: "VolumeX" };
}
