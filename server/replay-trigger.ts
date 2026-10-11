// Starts the memory replay from a file, so a Claude session can start it without ⌘K. The plugin polls the start
// file, removes it, and writes what happened next to it (`replay-start.result.json`).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { startMemoryReplay } from "../shared/replay-rpc";

export const REPLAY_START_FILE = join(homedir(), ".orchestrator", "replay-start.json");

// How often the plugin looks for the start file.
export const REPLAY_START_POLL_MS = 5_000;

type StartInput = RpcInput<typeof startMemoryReplay>;
type Started = RpcOutput<typeof startMemoryReplay>;
export type StartResult = ({ ok: true } & Started) | { ok: false; error: string };

export const resultFile = (file: string) => file.replace(/\.json$/, "") + ".result.json";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function writeStartResult(file: string, result: StartResult): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(resultFile(file), JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2) + "\n");
}

// The start request, removed as it is read so it can never start twice; null when there is none.
// A bad request is written to the result file and comes back as an error.
export function takeStartRequest(file: string): { ok: true; input: StartInput } | { ok: false; error: string } | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  rmSync(file, { force: true });
  let failed: string;
  try {
    const parsed = startMemoryReplay.input.safeParse(JSON.parse(text));
    if (parsed.success) return { ok: true, input: parsed.data };
    failed = `${file}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
  } catch (error) {
    failed = `${file}: ${message(error)}`;
  }
  writeStartResult(file, { ok: false, error: failed });
  return { ok: false, error: failed };
}

// One poll: nothing without a start file, and the file waits while there is no Paseo API to start with.
export async function tickReplayStart(file: string, ready: () => boolean, start: (input: StartInput) => Promise<Started>): Promise<void> {
  if (!ready()) return;
  const taken = takeStartRequest(file);
  if (!taken?.ok) return;
  try {
    writeStartResult(file, { ok: true, ...(await start(taken.input)) });
  } catch (error) {
    writeStartResult(file, { ok: false, error: message(error) });
  }
}
