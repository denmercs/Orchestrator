import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ContextSummary } from "../shared/context";

// Context telemetry (see CONTEXT.md, "Telemetry row"): one JSON line per event, read back as
// totals for the dashboard card. `provider` is recorded for analysis only and never branched on.

export const TELEMETRY_FILE = join(homedir(), ".orchestrator", "context-telemetry.jsonl");

// Past this size the file moves to `<name>.1.jsonl` (replacing any older copy) and a new one starts.
export const TELEMETRY_MAX_BYTES = 5 * 1024 * 1024;

function rotatedFile(file: string): string {
  return file.endsWith(".jsonl") ? `${file.slice(0, -".jsonl".length)}.1.jsonl` : `${file}.1`;
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

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
  // Absent on rows written before S6. `model` is null when the agent runs its provider's default.
  model?: string | null;
  // From the `loop-cycle` and `loop-story` labels; null outside the loop.
  cycle?: number | null;
  story?: string | null;
};

// Appends go through one chain so concurrent turn ends never interleave a line.
let writes: Promise<void> = Promise.resolve();

export function recordTelemetry(
  row: TelemetryRow,
  file: string = TELEMETRY_FILE,
  maxBytes: number = TELEMETRY_MAX_BYTES,
): Promise<void> {
  const write = writes.then(async () => {
    const line = `${JSON.stringify(row)}\n`;
    await mkdir(dirname(file), { recursive: true });
    const size = await sizeOf(file);
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes) await rename(file, rotatedFile(file));
    await appendFile(file, line, "utf8");
  });
  writes = write.catch(() => undefined);
  return write;
}

async function readRows(file: string): Promise<TelemetryRow[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: TelemetryRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as TelemetryRow);
    } catch {
      // A torn or hand-edited line is skipped, not fatal.
    }
  }
  return rows;
}

// Totals over rows with `at >= since` (every row when since is null), read from the rotated
// file and the current one so totals survive a rotation. A session counts as over threshold
// when it has a `warning` row. `byStep` covers only `turn` rows with a step.
export async function summariseTelemetry(
  since: string | null,
  file: string = TELEMETRY_FILE,
): Promise<ContextSummary> {
  const rows = [...(await readRows(rotatedFile(file))), ...(await readRows(file))].filter((row) => since === null || row.at >= since);
  const summary: ContextSummary = {
    turns: 0,
    sessions: 0,
    sessionsOverThreshold: 0,
    warnings: 0,
    compactions: { native: 0, fresh: 0, inferred: 0 },
    ignored: 0,
    reminded: 0,
    tokensAvoided: 0,
    byStep: {},
  };
  const sessions = new Set<string>();
  const overThreshold = new Set<string>();
  const stepModels = new Map<string, Set<string>>();
  for (const row of rows) {
    sessions.add(row.agentId);
    switch (row.event) {
      case "turn":
        summary.turns += 1;
        if (row.step != null) {
          const step = (summary.byStep[row.step] ??= { turns: 0, tokens: 0, models: [] });
          step.turns += 1;
          step.tokens += row.used ?? 0;
          const models = stepModels.get(row.step) ?? new Set<string>();
          models.add(row.model ?? "unknown");
          stepModels.set(row.step, models);
        }
        break;
      case "warning":
        summary.warnings += 1;
        overThreshold.add(row.agentId);
        break;
      case "ignore":
        summary.ignored += 1;
        break;
      case "remind":
        summary.reminded += 1;
        break;
      case "compact.native":
      case "compact.fresh":
      case "compact.inferred":
        summary.compactions[row.event.slice("compact.".length) as "native" | "fresh" | "inferred"] += 1;
        if (row.preTokens != null && row.used != null) {
          summary.tokensAvoided += Math.max(0, row.preTokens - row.used);
        }
        break;
    }
  }
  summary.sessions = sessions.size;
  summary.sessionsOverThreshold = overThreshold.size;
  for (const [step, models] of stepModels) summary.byStep[step].models = [...models].sort();
  return summary;
}
