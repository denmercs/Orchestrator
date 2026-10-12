// The voice transcription RPC. Imported by the client bundle, so it must stay free of node: modules and of server/ code.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// `audio` is base64 webm/opus from the mic; `hints` are words the transcriber should expect (commands, session names).
export const transcribeVoice = defineRpc({
  name: "orchestration.voice.transcribe",
  input: z.object({ audio: z.string(), hints: z.array(z.string()) }),
  output: z.object({ text: z.string() }),
});
