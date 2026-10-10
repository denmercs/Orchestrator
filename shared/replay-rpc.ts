// The memory-replay RPC. Imported by the client bundle, so it must not import ./memory or any node: module.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Starts the replay over `<root>/.harness/replay/corpus.jsonl`. It returns once the run has started; progress is in
// `<root>/.harness/replay/<run>/run.log` and `results.jsonl`. `costCap` overrides the default cap, `controls` limits the control rounds.
export const startMemoryReplay = defineRpc({
  name: "orchestration.replay.start",
  input: z.object({
    root: z.string().min(1),
    costCap: z.number().positive().optional(),
    controls: z.number().int().min(0).optional(),
  }),
  output: z.object({ run: z.string(), rounds: z.number(), costCap: z.number(), runDir: z.string() }),
});
