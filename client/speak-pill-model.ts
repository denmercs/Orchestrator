// The Speak replies pill, as data. Kept free of React and the Paseo client so it can be tested on its own.
import type { SpeakMode } from "../shared/speak-replies";

export type SpeakPillView = { title: string; label: string; icon: "Volume2" | "VolumeX" };

const NEXT: Record<SpeakMode, SpeakMode> = { off: "short", short: "medium", medium: "full", full: "off" };

/** What one press does: off → short → medium → full → off. */
export const nextSpeakMode = (mode: SpeakMode): SpeakMode => NEXT[mode];

export function speakPill(mode: SpeakMode): SpeakPillView {
  if (mode === "short") {
    return { title: "The first line of each reply is spoken. Press for a medium read", label: "Speak · short", icon: "Volume2" };
  }
  if (mode === "medium") {
    return { title: "Replies are spoken in brief: the gist, and what needs you. Press to speak the full reply", label: "Speak · medium", icon: "Volume2" };
  }
  if (mode === "full") {
    return { title: "Whole replies are spoken. Press to stop speaking them", label: "Speak · full", icon: "Volume2" };
  }
  return { title: "Speak this session's replies aloud", label: "Speak", icon: "VolumeX" };
}
