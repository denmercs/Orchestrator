import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { recordTelemetry, summariseTelemetry, type TelemetryRow } from "./context-telemetry";

// Seam tests pinned in S1 against stubs. S2 implements telemetry and removes `todo`.
const S2 = { todo: "S2" };

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "orchestrator-context-telemetry-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function row(at: string, agentId: string, used: number, event: TelemetryRow["event"], extra: Partial<TelemetryRow> = {}): TelemetryRow {
  return { at, agentId, provider: "claude", step: null, used, max: 200_000, event, ...extra };
}

const ROWS: TelemetryRow[] = [
  row("2026-10-01T10:00:00.000Z", "a1", 40_000, "turn"),
  row("2026-10-01T11:00:00.000Z", "a1", 120_000, "turn"),
  row("2026-10-01T11:00:00.001Z", "a1", 120_000, "warning", { level: "amber" }),
  row("2026-10-01T11:01:00.000Z", "a1", 120_000, "remind"),
  row("2026-10-01T12:00:00.000Z", "a1", 30_000, "compact.native", { preTokens: 150_000 }),
  row("2026-10-01T13:00:00.000Z", "a2", 110_000, "turn"),
  row("2026-10-01T13:00:00.001Z", "a2", 110_000, "warning", { level: "amber" }),
  row("2026-10-01T13:01:00.000Z", "a2", 110_000, "ignore"),
];

test("summariseTelemetry counts recorded rows", S2, async () => {
  const file = join(root, "all.jsonl");
  for (const r of ROWS) await recordTelemetry(r, file);

  assert.deepEqual(await summariseTelemetry(null, file), {
    turns: 3,
    sessions: 2,
    sessionsOverThreshold: 2,
    warnings: 2,
    compactions: { native: 1, fresh: 0, inferred: 0 },
    ignored: 1,
    reminded: 1,
    tokensAvoided: 120_000,
  });
});

test("summariseTelemetry drops rows before since", S2, async () => {
  const file = join(root, "since.jsonl");
  for (const r of ROWS) await recordTelemetry(r, file);

  const summary = await summariseTelemetry("2026-10-01T10:30:00.000Z", file);
  assert.equal(summary.turns, 2);
  assert.equal(summary.sessions, 2);
});
