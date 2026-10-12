// The Voice helper RPCs. Imported by the client bundle, so it must stay free of node: modules and of server/ code.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

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
