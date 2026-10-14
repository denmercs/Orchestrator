import { PASEO_VOICE_LINE, PASEO_VOICE_TITLE, NO_MIC_MESSAGE, spokenLine } from "../shared/voice-lines";
import type { VoiceEvent } from "../shared/voice-loop";

// Pure: does this device give a plugin a microphone API? Paseo's phone app gives plugins no navigator.mediaDevices.
export function hasMicApi(nav: { mediaDevices?: { getUserMedia?: unknown } } | undefined): boolean {
  return typeof nav?.mediaDevices?.getUserMedia === "function";
}

export type DrawerMicView =
  | { kind: "mic"; error: string | null }
  | { kind: "paseo-voice"; title: string; notice: string; error: string | null };

// Pure: what the drawer shows for the mic. No mic API means the Paseo voice view (a prompt to turn on Paseo voice mode), and the no-mic error is not repeated.
export function drawerMicView(input: { hasMicApi: boolean; error: string | null }): DrawerMicView {
  if (input.hasMicApi) return { kind: "mic", error: input.error };
  return {
    kind: "paseo-voice",
    title: PASEO_VOICE_TITLE,
    notice: PASEO_VOICE_LINE,
    error: input.error === NO_MIC_MESSAGE ? null : input.error,
  };
}

// Pure: the text the phone drawer shows for a reply to its target. Jarvis speaks it, so this is never spoken here.
export function phoneReplyLine(event: VoiceEvent, targetId: string | null | undefined): string | null {
  if (event.type !== "reply" || !targetId || event.sessionId !== targetId) return null;
  return spokenLine(event.text) || null;
}

// Pure: why new voice sessions have no model of their own, shown instead of a dead control. Null when the setting is fine.
export function voiceOffNotice(profile: string): string | null {
  if (profile.trim().toLowerCase() !== "off") return null;
  return "Voice sessions are set to off, so they stay on the Paseo default model. Pick a model under Sessions & settings to change that.";
}

// Pure: the drawer's "Ignore me" switch. It is the mic setting seen from the other side (voice.micOff): on means the mic is
// off and what you say is dropped. Default is off (the mic is on and you are heard).
export function ignoreMeView(micOn: boolean): { label: string; on: boolean; status: string | null; action: string } {
  return {
    label: "Ignore me",
    on: !micOn,
    status: micOn ? null : "Ignoring you. Jarvis won't act on what you say.",
    action: micOn ? "Turn Ignore me on" : "Turn Ignore me off",
  };
}
