// The "Speak replies" modes' RPCs (the voice pill's menu). Imported by the client bundle, so it must stay free of node: modules
// and of server/ code.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const speakModeSchema = z.enum(["off", "short", "medium", "full"]);
export type SpeakMode = z.infer<typeof speakModeSchema>;

// Sets how one session speaks its replies: off, the short opening line, a medium squeeze of the reply, or the whole message. Rejects (so Paseo toasts) when the speak script is missing.
export const speakRepliesSet = defineRpc({
  name: "orchestration.speak-replies.set",
  input: z.object({ agentId: z.string(), mode: speakModeSchema }),
  output: z.object({ ok: z.boolean() }),
});

// The sessions that currently speak their replies, with how much of each.
export const speakRepliesState = defineRpc({
  name: "orchestration.speak-replies.state",
  input: z.object({}),
  output: z.object({ modes: z.record(z.string(), z.enum(["short", "medium", "full"])) }),
});
