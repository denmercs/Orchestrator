// Drives the initiative story loop from a file, so `/orbit` (skills/plan/orbit) can plan a phase, start or stop the
// loop without the Initiatives tab. Plan is the tab's New phase; Start and Stop run the story loop directly (the tab's
// Start files slices for the factory manager instead). The plugin polls the file, removes it, and
// writes what happened next to it (`orbit.result.json`).
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { tickStartFile } from "./start-file";

export const ORBIT_FILE = join(homedir(), ".orchestrator", "orbit.json");

// How often the plugin looks for the orbit file.
export const ORBIT_POLL_MS = 5_000;

const target = { repo: z.string().min(1), initiative: z.string().min(1) };

export const orbitRequest = z.discriminatedUnion("action", [
  // A new phase and its architecture session; creates the initiative first when it's new, titled `title`.
  z.object({ action: z.literal("plan"), ...target, phase: z.string().min(1), title: z.string().default("") }),
  z.object({ action: z.literal("start"), ...target }),
  z.object({ action: z.literal("stop"), ...target }),
]);

export type OrbitRequest = z.infer<typeof orbitRequest>;
type Action<A extends OrbitRequest["action"]> = Extract<OrbitRequest, { action: A }>;

export type OrbitPorts = {
  plan: (input: Action<"plan">) => Promise<object>;
  start: (input: Action<"start">) => Promise<object>;
  stop: (input: Action<"stop">) => Promise<object>;
};

export const tickOrbit = (file: string, ready: () => boolean, ports: OrbitPorts) =>
  tickStartFile(file, orbitRequest, ready, async (input) => {
    const done =
      input.action === "plan" ? await ports.plan(input) : input.action === "start" ? await ports.start(input) : await ports.stop(input);
    return { action: input.action, ...done };
  });
