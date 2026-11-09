// The Sulti strip RPCs. Imported by the client bundle, so it must stay free of node: modules and of server/ code.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// The Sulti session's id and its latest reply (with when it was said). `error` is the failure text, with the rest null.
export const sultiStripRead = defineRpc({
  name: "orchestration.sulti-strip.read",
  input: z.object({}),
  output: z.object({
    sultiId: z.string().nullable(),
    reply: z.string().nullable(),
    at: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

// Routes typed text through the Sulti router. `spoken` is shown as lines; `note` is shown after them.
export const sultiStripSend = defineRpc({
  name: "orchestration.sulti-strip.send",
  input: z.object({ text: z.string() }),
  output: z.object({ spoken: z.array(z.string()), note: z.string().nullable() }),
});
