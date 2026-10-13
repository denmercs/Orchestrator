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

// Cleans one transcript. Errors reach the client, which falls back to sending the words as heard.
export const voiceInterpret = defineRpc({
  name: "orchestration.voice.interpret",
  input: z.object({
    transcript: z.string(),
    sessionId: z.string(),
    sessions: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
  output: z.union([
    z.object({ type: z.literal("send"), text: z.string() }),
    z.object({ type: z.literal("confirm"), text: z.string() }),
    z.object({ type: z.literal("switch"), name: z.string() }),
    z.object({ type: z.literal("drop") }),
  ]),
});

// The Voice drawer's target, told to the server so the Jarvis router sends to the same session.
export const voiceTarget = defineRpc({
  name: "orchestration.voice.target",
  input: z.object({ id: z.string().max(200), name: z.string().max(200) }),
  output: z.object({ ok: z.boolean() }),
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

// Long poll for the drawer: answers at once when there are events past `after`, else waits up to 20 s. `phoneActive`
// means Jarvis is speaking on the phone, so the drawer stays quiet.
export const voiceEvents = defineRpc({
  name: "orchestration.voice.events",
  input: z.object({ after: z.number().int().min(0) }),
  output: z.object({
    cursor: z.number().int().min(0),
    events: z.array(z.custom<VoiceEvent>((v) => v !== null && typeof v === "object" && typeof (v as { type?: unknown }).type === "string")),
    phoneActive: z.boolean(),
  }),
});
