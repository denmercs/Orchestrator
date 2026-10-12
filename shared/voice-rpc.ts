// The voice transcription RPC. Imported by the client bundle, so it must stay free of node: modules and of server/ code.
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
