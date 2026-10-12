// The Speak replies pill, as data. Kept free of React and the Paseo client so it can be tested on its own.

export type SpeakPillView = { title: string; label: string; icon: "Volume2" | "VolumeX" };

export function speakPill(on: boolean): SpeakPillView {
  return on
    ? { title: "Replies are spoken. Press to stop speaking them", label: "Speak · on", icon: "Volume2" }
    : { title: "Speak this session's replies aloud", label: "Speak", icon: "VolumeX" };
}
