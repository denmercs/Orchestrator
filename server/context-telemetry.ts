import { homedir } from "node:os";
import { join } from "node:path";
import type { ContextSummary } from "../shared/context";

// Context telemetry (see CONTEXT.md, "Telemetry row"): one JSON line per event, read back as
// totals for the dashboard card. `provider` is recorded for analysis only and never branched on.

export const TELEMETRY_FILE = join(homedir(), ".orchestrator", "context-telemetry.jsonl");

export type TelemetryEvent =
  | "turn"
  | "warning"
  | "compact.native"
  | "compact.fresh"
  | "compact.inferred"
  | "ignore"
  | "remind";

export type TelemetryRow = {
  at: string;
  agentId: string;
  provider: string;
  step: string | null;
  used: number | null;
  max: number | null;
  event: TelemetryEvent;
  // On `warning` rows.
  level?: "amber" | "red";
  // On `compact.*` rows: the context before the compact.
  preTokens?: number;
};

export async function recordTelemetry(_row: TelemetryRow, _file: string = TELEMETRY_FILE): Promise<void> {
  throw new Error("not implemented (S2)");
}

// Totals over rows with `at >= since` (every row when since is null). A session counts as over
// threshold when it has a `warning` row.
export async function summariseTelemetry(
  _since: string | null,
  _file: string = TELEMETRY_FILE,
): Promise<ContextSummary> {
  throw new Error("not implemented (S2)");
}
