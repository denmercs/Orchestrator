// Starts the memory replay from a file, so a Claude session can start it without ⌘K. The plugin polls the start
// file, removes it, and writes what happened next to it (`replay-start.result.json`).
import { homedir } from "node:os";
import { join } from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { startMemoryReplay } from "../shared/replay-rpc";
import { takeStartFile, tickStartFile, type StartResult as FileStartResult } from "./start-file";

export { resultFile, writeStartResult } from "./start-file";

export const REPLAY_START_FILE = join(homedir(), ".orchestrator", "replay-start.json");

// How often the plugin looks for the start file.
export const REPLAY_START_POLL_MS = 5_000;

type StartInput = RpcInput<typeof startMemoryReplay>;
type Started = RpcOutput<typeof startMemoryReplay>;
export type StartResult = FileStartResult<Started>;

export const takeStartRequest = (file: string) => takeStartFile(file, startMemoryReplay.input);

export const tickReplayStart = (file: string, ready: () => boolean, start: (input: StartInput) => Promise<Started>) =>
  tickStartFile(file, startMemoryReplay.input, ready, start);
