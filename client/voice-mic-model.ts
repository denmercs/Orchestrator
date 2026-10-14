import { JARVIS_VOICE_LINE, JARVIS_VOICE_TITLE, NO_MIC_MESSAGE, spokenLine } from "../shared/voice-lines";
import type { VoiceEvent } from "../shared/voice-loop";

// Pure: does this device give a plugin a microphone API? Paseo's phone app gives plugins no navigator.mediaDevices.
export function hasMicApi(nav: { mediaDevices?: { getUserMedia?: unknown } } | undefined): boolean {
  return typeof nav?.mediaDevices?.getUserMedia === "function";
}

export type DrawerMicView =
  | { kind: "mic"; error: string | null }
  | { kind: "jarvis"; title: string; notice: string; error: string | null };

// Pure: what the drawer shows for the mic. No mic API means a Jarvis card, and the no-mic error is not repeated.
export function drawerMicView(input: { hasMicApi: boolean; error: string | null }): DrawerMicView {
  if (input.hasMicApi) return { kind: "mic", error: input.error };
  return {
    kind: "jarvis",
    title: JARVIS_VOICE_TITLE,
    notice: JARVIS_VOICE_LINE,
    error: input.error === NO_MIC_MESSAGE ? null : input.error,
  };
}

// Pure: the text the phone drawer shows for a reply to its target. Jarvis speaks it, so this is never spoken here.
export function phoneReplyLine(event: VoiceEvent, targetId: string | null | undefined): string | null {
  if (event.type !== "reply" || !targetId || event.sessionId !== targetId) return null;
  return spokenLine(event.text) || null;
}
