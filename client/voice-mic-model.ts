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

// Pure: the drawer's "Ignore me" switch. It shows the saved voice.micOff pref (`ignoring`), never whether the mic opened: on
// means what you say is dropped. Default is off (you are heard), also after a reload.
export function ignoreMeView(ignoring: boolean): { label: string; on: boolean; status: string | null; action: string } {
  return {
    label: "Ignore me",
    on: ignoring,
    status: ignoring ? "Ignoring you. Jarvis won't act on what you say." : null,
    action: ignoring ? "Turn Ignore me off" : "Turn Ignore me on",
  };
}

// Pure: the drawer's voice status. Paseo gives plugins no voice state, so this is only a guess from the sessions it opened.
export function voiceStatusLine(guess: "on" | "off" | "unknown"): string {
  if (guess === "on") return "Voice on (best guess)";
  if (guess === "off") return "Voice off (best guess)";
  return "Voice status unknown";
}

// Paseo's recorder is Paseo's: a plugin can't stop or mute it, so the drawer says where the real control is.
export const PASEO_STOP_HINT = "Ignore me only drops what Jarvis acts on. To stop the recording itself, use Paseo's own Stop or Mute button.";

export const SETTINGS_UNREADABLE_NOTICE = "Can't read voice settings, using defaults (the mic is on and you are heard).";

// Pure: the drawer's link to the Jarvis session's Paseo chat. The plugin can open it but not embed or focus its composer.
export function openChatView(agentId: string | null, hasNavigation: boolean): { label: string; disabled: boolean; reason: string | null } {
  const label = "Open in Paseo chat";
  if (!hasNavigation) return { label, disabled: true, reason: "This Paseo can't open a chat from here." };
  if (!agentId) return { label, disabled: true, reason: "No Jarvis session yet. Start one to chat." };
  return { label, disabled: false, reason: null };
}
