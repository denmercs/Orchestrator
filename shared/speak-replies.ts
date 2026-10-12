// The "Speak replies" pill's RPCs. Imported by the client bundle, so it must stay free of node: modules
// and of server/ code.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Switches spoken replies on or off for one session. Rejects (so Paseo toasts) when the speak script is missing.
export const speakRepliesSet = defineRpc({
  name: "orchestration.speak-replies.set",
  input: z.object({ agentId: z.string(), on: z.boolean() }),
  output: z.object({ ok: z.boolean() }),
});

// The sessions that currently speak their replies.
export const speakRepliesState = defineRpc({
  name: "orchestration.speak-replies.state",
  input: z.object({}),
  output: z.object({ agentIds: z.array(z.string()) }),
});
