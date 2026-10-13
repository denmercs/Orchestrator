// The voice RPCs: transcription and the Voice helper. Imported by the client bundle, so it must stay free of node:
// modules and of server/ code.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

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

// Reads (no `enabled`) or flips the helper's switch, which lives in the server's interpret service. Both the drawer
// and Jarvis follow it. Answers the switch as it is now.
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

// The Voice drawer's target, told to the server so the Jarvis router sends to the same session.
export const voiceTarget = defineRpc({
  name: "orchestration.voice.target",
  input: z.object({ id: z.string().max(200), name: z.string().max(200) }),
  output: z.object({ ok: z.boolean() }),
});
