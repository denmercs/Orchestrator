// The Voice pill, as data. Kept free of React and the Paseo client so it can be tested on its own.
import type { SpeakMode } from "../shared/speak-replies";
import type { VoiceMode, VoiceSession } from "../shared/voice-loop";

export type VoicePillView = { label: string; title: string };

const MODE_TITLES: Record<VoiceMode, string> = {
  asleep: 'Voice is on, asleep. Say "Hey Jarvis"',
  listening: "Voice is listening to this session",
  confirming: "Voice is waiting for you to confirm",
  waiting: "Voice is waiting for this session to reply",
  speaking: "Voice is speaking a reply",
};

// Shared with the Jarvis router, which names sessions the same way.
export { canTarget, sessionName, splitSessions, voiceSessions } from "../shared/voice-loop";

const SPEAK_MODES: readonly SpeakMode[] = ["off", "short", "medium", "full"];

const SPEAK_TITLES: Record<Exclude<SpeakMode, "off">, string> = {
  short: "Replies are spoken (short): the first line of each",
  medium: "Replies are spoken (medium): the gist, and what needs you",
  full: "Replies are spoken (full): the whole reply",
};

type VoiceState = { mode: VoiceMode; session: VoiceSession | null; micOn: boolean };

// Shown on every targetable session in every state: Voice · off (the mic is off), Voice · asleep, Voice ·
// listening, … Only the title tells the target apart from an invitation to tap another session. Spoken
// replies add " · speak <mode>". `state` is null when there is no voice runner: the pill is then the speak
// control alone. `speak` is "off" until the session's replies are spoken.
export function voicePill(agent: { id: string }, state: VoiceState | null, speak: SpeakMode = "off"): VoicePillView {
  if (!state) {
    return speak === "off"
      ? { label: "Speak replies", title: "Speak this session's replies aloud" }
      : { label: `Speak · ${speak}`, title: SPEAK_TITLES[speak] };
  }
  const label = state.micOn ? `Voice · ${state.mode}` : "Voice · off";
  const isTarget = state.session?.id === agent.id;
  const title = isTarget ? (state.micOn ? MODE_TITLES[state.mode] : "Voice is off") : "Tap to talk to this session";
  if (speak === "off") return { label, title };
  return { label: `${label} · speak ${speak}`, title: `${title}. ${SPEAK_TITLES[speak]}` };
}

export type VoiceMenuAction = { kind: "talk" } | { kind: "speak"; mode: SpeakMode };
export type VoiceMenuEntry =
  | { kind: "separator"; id: string }
  | { kind: "item"; id: string; title: string; icon: "Mic" | "Check" | null; action: VoiceMenuAction };

// The pill's menu: talk to this session, then the speak modes with the current one checked. `talk` is
// whether the session can be a target; `speak` is its mode, or null when it can't speak (a worker's
// replies belong to its harness).
export function voicePillMenu(input: { talk: boolean; speak: SpeakMode | null }): VoiceMenuEntry[] {
  const entries: VoiceMenuEntry[] = [];
  if (input.talk) entries.push({ kind: "item", id: "talk", title: "Talk to this session", icon: "Mic", action: { kind: "talk" } });
  if (input.speak === null) return entries;
  if (input.talk) entries.push({ kind: "separator", id: "speak-separator" });
  for (const mode of SPEAK_MODES) {
    entries.push({
      kind: "item",
      id: `speak-${mode}`,
      title: `Speak replies: ${mode}`,
      icon: input.speak === mode ? "Check" : null,
      action: { kind: "speak", mode },
    });
  }
  return entries;
}
