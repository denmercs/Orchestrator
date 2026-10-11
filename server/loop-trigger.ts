// Starts the initiative loop from a file, so a Claude session can start it without the Initiatives tab. The plugin
// polls the start file, removes it, and writes what happened next to it (`initiative-loop-start.result.json`).
import { homedir } from "node:os";
import { join } from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { startInitiativeLoop } from "../shared/initiative-loop";
import { tickStartFile } from "./start-file";

export const LOOP_START_FILE = join(homedir(), ".orchestrator", "initiative-loop-start.json");

// How often the plugin looks for the start file.
export const LOOP_START_POLL_MS = 5_000;

export const tickLoopStart = (
  file: string,
  ready: () => boolean,
  start: (input: RpcInput<typeof startInitiativeLoop>) => Promise<RpcOutput<typeof startInitiativeLoop>>,
) => tickStartFile(file, startInitiativeLoop.input, ready, start);
