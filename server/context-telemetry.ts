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
  // From the `loop-cycle`, `loop-story` and `loop-initiative` labels; null outside the loop.
  cycle?: number | null;
  story?: string | null;
  // Absent on rows written before S18. Story ids repeat across initiatives, so this tells them apart.
  initiative?: string | null;
  // The session's cumulative cost at this row; absent before S10, null when the provider reports none.
  costUsd?: number | null;
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

// Every row, oldest first: the rotated file, then the current one.
export async function readTelemetry(file: string = TELEMETRY_FILE): Promise<TelemetryRow[]> {
  return [...(await readRows(rotatedFile(file))), ...(await readRows(file))];
}

export type StoryKey = {
  initiative: string;
  story: string;
  agentId: string;
  step: string | null;
  cycle?: number | null;
};

export type StoryHistory = {
  // 1 + the `compact.fresh` rows for this step (and cycle, when given) since the story last
  // ran a different step, so a second round of a step starts again at 1.
  session: number;
  // The agent's `compact.native` + `compact.inferred` rows.
  compactions: number;
  // The agent's turn `used` values after its last `compact.*` row, oldest first.
  turns: number[];
};

// Rows written before S18 have no initiative and never match a story.
export function storyHistory(rows: TelemetryRow[], key: StoryKey): StoryHistory {
  const story = rows.filter((row) => row.initiative === key.initiative && row.story === key.story);
  let lastOtherStep = -1;
  story.forEach((row, i) => {
    if (row.step != null && row.step !== key.step) lastOtherStep = i;
  });
  const fresh = story
    .slice(lastOtherStep + 1)
    .filter((row) => row.event === "compact.fresh" && row.step === key.step && (key.cycle == null || row.cycle === key.cycle));

  const agent = rows.filter((row) => row.agentId === key.agentId);
  let compactions = 0;
  let turns: number[] = [];
  for (const row of agent) {
    if (row.event.startsWith("compact.")) {
      if (row.event !== "compact.fresh") compactions += 1;
      turns = [];
    } else if (row.event === "turn" && row.used != null) {
      turns.push(row.used);
    }
  }
  return { session: fresh.length + 1, compactions, turns };
}

// Σ over the story's agents of each one's last `costUsd` (costs are cumulative per session);
// null when none of its rows has a cost. Rows written before S18 have no initiative and never match.
export function storyCost(rows: TelemetryRow[], key: { initiative: string; story: string }): number | null {
  const last = new Map<string, number>();
  for (const row of rows) {
    if (row.initiative !== key.initiative || row.story !== key.story || typeof row.costUsd !== "number") continue;
    last.set(row.agentId, row.costUsd);
  }
  if (last.size === 0) return null;
  let total = 0;
  for (const cost of last.values()) total += cost;
  return total;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// Σ over agents of (last cost at or after `start` − last cost before it, 0 when none), clamped at 0
// per agent. `rows` holds only rows with a cost; costs are cumulative per session.
function spendSince(byAgent: Map<string, { at: string; costUsd: number }[]>, start: string): number {
  let total = 0;
  for (const costs of byAgent.values()) {
    let baseline = 0;
    let last: number | null = null;
    for (const cost of costs) {
      if (cost.at < start) baseline = cost.costUsd;
      else last = cost.costUsd;
    }
    if (last !== null) total += Math.max(0, last - baseline);
  }
  return total;
}

// Totals over rows with `at >= since` (every row when since is null), read from the rotated
// file and the current one so totals survive a rotation. A session counts as over threshold
// when it has a `warning` row. `byStep` covers only `turn` rows with a step, `byStory` only those with a story.
// Spend ignores `since`: it reads every row with a cost, from `today` (ISO start of today; the
// server's local midnight when absent) and from the start of the day six days earlier.
export async function summariseTelemetry(
  since: string | null,
  file: string = TELEMETRY_FILE,
  today?: string,
): Promise<ContextSummary> {
  const allRows = await readTelemetry(file);
  const rows = allRows.filter((row) => since === null || row.at >= since);
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
    byStory: {},
    spendToday: 0,
    spendWeek: 0,
  };
  const sessions = new Set<string>();
  const overThreshold = new Set<string>();
  const stepModels = new Map<string, Set<string>>();
  const storyModels = new Map<string, Set<string>>();
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
        if (row.story != null) {
          const key = `${row.initiative ?? "unknown"}/${row.story}`;
          const story = (summary.byStory[key] ??= { turns: 0, tokens: 0, models: [] });
          story.turns += 1;
          story.tokens += row.used ?? 0;
          const models = storyModels.get(key) ?? new Set<string>();
          models.add(row.model ?? "unknown");
          storyModels.set(key, models);
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
  for (const [key, models] of storyModels) summary.byStory[key].models = [...models].sort();

  const costs = new Map<string, { at: string; costUsd: number }[]>();
  for (const row of allRows) {
    if (typeof row.costUsd !== "number") continue;
    const agent = costs.get(row.agentId) ?? [];
    agent.push({ at: row.at, costUsd: row.costUsd });
    costs.set(row.agentId, agent);
  }
  for (const agent of costs.values()) agent.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const dayStart = today === undefined ? startOfLocalDay(new Date()) : new Date(today);
  const weekStart = new Date(dayStart);
  // The caller's midnight steps back whole UTC days, so a DST change in the server's zone can't move it.
  if (today === undefined) weekStart.setDate(weekStart.getDate() - 6);
  else weekStart.setUTCDate(weekStart.getUTCDate() - 6);
  summary.spendToday = spendSince(costs, dayStart.toISOString());
  summary.spendWeek = spendSince(costs, weekStart.toISOString());
  return summary;
}
