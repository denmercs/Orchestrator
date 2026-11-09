import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Start paths file work for the factory manager instead of starting a loop: each writes slices into
// mission `inbox` of the harness repo's factory and steers the manager once. A steer that fails after
// the files are written still answers `ok`, with a `warning`.
const filed = {
  ok: z.boolean(),
  error: z.string().nullable(),
  slices: z.array(z.string()),
  warning: z.string().nullable(),
};

// One slice per not-yet-started story in the initiative's active phase (the Initiatives tab's Start buttons).
export const fileInitiativeRpc = defineRpc({
  name: "orchestration.factory.file-initiative",
  input: z.object({ repo: z.string(), initiative: z.string() }),
  output: z.object(filed),
});

// One slice from typed text (the Start input's new-initiative route).
export const fileSliceRpc = defineRpc({
  name: "orchestration.factory.file-slice",
  input: z.object({ title: z.string() }),
  output: z.object(filed),
});
