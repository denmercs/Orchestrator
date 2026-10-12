// The Voice pill, as data. Kept free of React and the Paseo client so it can be tested on its own.
import type { VoiceMode, VoiceSession } from "../shared/voice-loop";

export type VoicePillView = { label: string; title: string };

const MODE_TITLES: Record<Exclude<VoiceMode, "asleep">, string> = {
  listening: "Voice is listening to this session",
  confirming: "Voice is waiting for you to confirm",
  waiting: "Voice is waiting for this session to reply",
  speaking: "Voice is speaking a reply",
};

export function sessionName(agent: { id: string; title?: string | null }): string {
  return agent.title?.trim() || agent.id.slice(0, 8);
}

export function voiceSessions(agents: Array<{ id: string; title?: string | null }>): VoiceSession[] {
  return agents.map((agent) => ({ id: agent.id, name: sessionName(agent) }));
}

export function voicePill(
  agent: { id: string },
  state: { mode: VoiceMode; session: VoiceSession | null },
): VoicePillView | null {
  if (state.mode === "asleep") return null;
  if (state.session?.id === agent.id) return { label: `Voice · ${state.mode}`, title: MODE_TITLES[state.mode] };
  return { label: "Voice", title: "Tap to talk to this session" };
}
