// The Voice pill, as data. Kept free of React and the Paseo client so it can be tested on its own.
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

// Shown on every targetable session in every state: Voice · off (the mic is off), Voice · asleep, Voice ·
// listening, … Only the title tells the target apart from an invitation to tap another session.
export function voicePill(
  agent: { id: string },
  state: { mode: VoiceMode; session: VoiceSession | null; micOn: boolean },
): VoicePillView {
  const label = state.micOn ? `Voice · ${state.mode}` : "Voice · off";
  const isTarget = state.session?.id === agent.id;
  const title = isTarget ? (state.micOn ? MODE_TITLES[state.mode] : "Voice is off") : "Tap to talk to this session";
  return { label, title };
}
