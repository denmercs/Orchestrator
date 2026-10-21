// The voice RPCs: transcription and the Voice helper. Imported by the client bundle, so it must stay free of node:
// modules and of server/ code.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { VoiceEvent } from "./voice-loop";

// A 30 s opus clip is well under 1 MB; the caps keep a bad caller from filling the temp dir or whisper's prompt.
export const MAX_AUDIO_CHARS = 8_000_000;
export const MAX_HINTS = 100;

// `audio` is base64 webm/opus from the mic; `hints` are words the transcriber should expect (commands, session names).
export const transcribeVoice = defineRpc({
  name: "orchestration.voice.transcribe",
  input: z.object({ audio: z.string().max(MAX_AUDIO_CHARS), hints: z.array(z.string().max(200)).max(MAX_HINTS) }),
  output: z.object({ text: z.string() }),
});

// Starts the helper agent when voice turns on (or does nothing if it is already up).
export const voiceHelperStart = defineRpc({
  name: "orchestration.voice.helper.start",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});

// Archives the helper agent when voice turns off.
export const voiceHelperStop = defineRpc({
  name: "orchestration.voice.helper.stop",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});

// Reads (no `enabled`) or flips the helper's switch, which lives in the server's interpret service. Both the voice
// runner and Jarvis follow it. Answers the switch as it is now.
export const voiceHelperSwitch = defineRpc({
  name: "orchestration.voice.helper.switch",
  input: z.object({ enabled: z.boolean().optional() }),
  output: z.object({ enabled: z.boolean() }),
});

const interpretResult = z.union([
  z.object({ type: z.literal("send"), text: z.string() }),
  z.object({ type: z.literal("switch"), name: z.string() }),
  z.object({ type: z.literal("sendTo"), session: z.string(), text: z.string() }),
  z.object({ type: z.literal("drop") }),
]);

// Cleans one transcript and says how: the helper, or the words as heard (with why). Never rejects on a slow or
// failed helper; the service falls back itself.
export const voiceInterpret = defineRpc({
  name: "orchestration.voice.interpret",
  input: z.object({
    transcript: z.string(),
    sessionId: z.string(),
    sessions: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
  output: z.object({
    result: interpretResult,
    via: z.enum(["helper", "passThrough"]),
    reason: z.enum(["timeout", "error", "starting"]).optional(),
  }),
});

// Downloads one of the three openWakeWord ONNX models (cached under ~/.orchestrator/voice/models/wake/) as base64;
// the client cannot fetch GitHub directly (S0 lesson 4).
export const voiceWakeModel = defineRpc({
  name: "orchestration.voice.wake-model",
  input: z.object({ model: z.enum(["melspectrogram", "embedding", "hey_jarvis"]) }),
  output: z.object({ bytes: z.string() }),
});

// One sentence (or short reply) for the Speaker. `replyId` ties sentences of one reply together so that, once Chatterbox
// is too slow for one, the rest of that reply stays on Kokoro.
export const MAX_SPEAK_CHARS = 400;

// `audio` is base64 WAV. `engine: "loading"` means the Speaker's workers are still starting: `audio` is empty and the
// caller retries or stays silent rather than hanging past the RPC limit.
export const voiceSpeak = defineRpc({
  name: "orchestration.voice.speak",
  input: z.object({ text: z.string().max(MAX_SPEAK_CHARS), replyId: z.string().max(200) }),
  output: z.object({ audio: z.string(), engine: z.enum(["chatterbox", "kokoro", "loading"]) }),
});

// Long poll for the Mac's voice runner: answers at once when there are events past `after`, else waits up to 20 s. `phoneActive`
// means Jarvis is speaking on the phone, so the Mac stays quiet.
export const voiceEvents = defineRpc({
  name: "orchestration.voice.events",
  // `target`: the Mac's current voice target (the pill's pick), so the server knows its replies get a spoken summary.
  input: z.object({ after: z.number().int().min(0), target: z.string().max(200).optional() }),
  output: z.object({
    cursor: z.number().int().min(0),
    events: z.array(z.custom<VoiceEvent>((v) => v !== null && typeof v === "object" && typeof (v as { type?: unknown }).type === "string")),
    phoneActive: z.boolean(),
    // A best guess at whether Paseo voice mode is on, from the Jarvis sessions Paseo opened; absent from an older server.
    voice: z.enum(["on", "off", "unknown"]).optional(),
    // The saved voice setting can't be read, so Ignore me is off and speech goes through; the Mac says so.
    settingsUnreadable: z.boolean().optional(),
    // The saved Ignore me value hasn't been read yet, so the server is holding speech; the Mac says it is checking.
    settingsChecking: z.boolean().optional(),
  }),
});

// The morning briefing for the Mac's voice runner: spoken lines when the words are "good morning" or an open briefing's answer,
// null when they are not for it and the runner carries on as usual.
export const voiceBrief = defineRpc({
  name: "orchestration.voice.brief",
  input: z.object({ text: z.string().max(2000) }),
  output: z.object({ spoken: z.array(z.string()) }).nullable(),
});

// "Status" for the Mac's voice runner: one spoken line about the sessions' states when the words are a status ask, null when
// they are not and the runner carries on as usual.
export const voiceStatus = defineRpc({
  name: "orchestration.voice.status",
  input: z.object({ text: z.string().max(2000) }),
  output: z.object({ spoken: z.array(z.string()) }).nullable(),
});
