import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { recordTelemetry, summariseTelemetry, type TelemetryRow } from "./context-telemetry";

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

test("summariseTelemetry counts recorded rows", async () => {
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
    byStep: {},
    byStory: {},
    spendToday: 0,
    spendWeek: 0,
  });
});

test("summariseTelemetry totals turn rows per step", async () => {
  const file = join(root, "by-step.jsonl");
  const old: TelemetryRow = { at: "2026-10-01T10:04:00.000Z", agentId: "a3", provider: "claude", step: "implement", used: 50_000, max: 200_000, event: "turn" };
  const rows: TelemetryRow[] = [
    row("2026-10-01T10:00:00.000Z", "a1", 40_000, "turn", { step: "plan", model: "opus", cycle: null, story: "S6" }),
    row("2026-10-01T10:01:00.000Z", "a1", 60_000, "turn", { step: "plan", model: "opus", cycle: null, story: "S6" }),
    row("2026-10-01T10:02:00.000Z", "a2", 30_000, "turn", { step: "implement", model: "sonnet", cycle: 1, story: "S6" }),
    row("2026-10-01T10:03:00.000Z", "a2", 0, "turn", { step: "implement", model: "sonnet", cycle: 1, story: "S6", used: null }),
    old,
    row("2026-10-01T10:05:00.000Z", "a2", 120_000, "warning", { step: "implement", level: "amber", model: "sonnet" }),
    row("2026-10-01T10:06:00.000Z", "a4", 90_000, "turn", { model: "haiku" }),
  ];
  for (const r of rows) await recordTelemetry(r, file);

  assert.deepEqual((await summariseTelemetry(null, file)).byStep, {
    plan: { turns: 2, tokens: 100_000, models: ["opus"] },
    implement: { turns: 3, tokens: 80_000, models: ["sonnet", "unknown"] },
  });
});

test("summariseTelemetry totals turn rows per initiative and story", async () => {
  const file = join(root, "by-story.jsonl");
  const rows: TelemetryRow[] = [
    row("2026-10-01T10:00:00.000Z", "a1", 40_000, "turn", { model: "opus", story: "S1", initiative: "telemetry" }),
    row("2026-10-01T10:01:00.000Z", "a1", 60_000, "turn", { model: "sonnet", story: "S1", initiative: "telemetry" }),
    row("2026-10-01T10:02:00.000Z", "a2", 30_000, "turn", { model: "haiku", story: "S1", initiative: "skills" }),
    row("2026-10-01T10:03:00.000Z", "a3", 20_000, "turn", { story: "S1" }),
    row("2026-10-01T10:04:00.000Z", "a4", 90_000, "turn", { model: "opus", initiative: "telemetry" }),
    row("2026-10-01T10:05:00.000Z", "a1", 120_000, "warning", { level: "amber", story: "S1", initiative: "telemetry" }),
  ];
  for (const r of rows) await recordTelemetry(r, file);

  assert.deepEqual((await summariseTelemetry(null, file)).byStory, {
    "telemetry/S1": { turns: 2, tokens: 100_000, models: ["opus", "sonnet"] },
    "skills/S1": { turns: 1, tokens: 30_000, models: ["haiku"] },
    "unknown/S1": { turns: 1, tokens: 20_000, models: ["unknown"] },
  });
});

test("summariseTelemetry derives spend today and this week from cumulative session cost", async () => {
  const file = join(root, "spend.jsonl");
  const today = "2026-09-20T00:00:00.000Z";
  const rows: TelemetryRow[] = [
    // a3 spent only before the week: nothing counts.
    row("2026-09-01T10:00:00.000Z", "a3", 10_000, "turn", { costUsd: 9 }),
    // a1: 1.00 is the week baseline, 4.00 (last before today) the today baseline, 6.00 the last in both windows.
    row("2026-09-10T10:00:00.000Z", "a1", 10_000, "turn", { costUsd: 1 }),
    row("2026-09-15T10:00:00.000Z", "a1", 10_000, "turn", { costUsd: 3 }),
    row("2026-09-19T23:59:59.999Z", "a1", 10_000, "turn", { costUsd: 4 }),
    row(today, "a1", 10_000, "turn", { costUsd: 4.5 }),
    row("2026-09-20T06:00:00.000Z", "a1", 10_000, "turn", { costUsd: 6 }),
    // Pre-S10 shape and a provider with no cost: both skipped for spend.
    row("2026-09-20T07:00:00.000Z", "a1", 10_000, "turn"),
    row("2026-09-20T08:00:00.000Z", "a1", 10_000, "turn", { costUsd: null }),
    // a2: no baseline before the week; its cost falls today, which clamps at 0.
    row("2026-09-19T10:00:00.000Z", "a2", 10_000, "turn", { costUsd: 2 }),
    row("2026-09-20T01:00:00.000Z", "a2", 10_000, "turn", { costUsd: 0.5 }),
  ];
  for (const r of rows) await recordTelemetry(r, file);

  const summary = await summariseTelemetry("2026-09-20T05:00:00.000Z", file, today);
  assert.equal(summary.spendToday, 2);
  assert.equal(summary.spendWeek, 5.5);
  assert.equal(summary.turns, 3);
});

test("summariseTelemetry drops rows before since", async () => {
  const file = join(root, "since.jsonl");
  for (const r of ROWS) await recordTelemetry(r, file);

  const summary = await summariseTelemetry("2026-10-01T10:30:00.000Z", file);
  assert.equal(summary.turns, 2);
  assert.equal(summary.sessions, 2);
});

test("recordTelemetry rotates to .1.jsonl once the file would pass maxBytes", async () => {
  const file = join(root, "rotate.jsonl");
  const rotated = join(root, "rotate.1.jsonl");
  const first = row("2026-10-01T10:00:00.000Z", "a1", 40_000, "turn");
  const lineBytes = Buffer.byteLength(`${JSON.stringify(first)}\n`);

  await recordTelemetry(first, file, lineBytes * 2);
  await recordTelemetry(row("2026-10-01T10:00:01.000Z", "a1", 40_000, "turn"), file, lineBytes * 2);
  await recordTelemetry(row("2026-10-01T10:00:02.000Z", "a1", 40_000, "turn"), file, lineBytes * 2);

  assert.equal((await readFile(rotated, "utf8")).trim().split("\n").length, 2);
  assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 1);
});

test("recordTelemetry replaces an older .1.jsonl on the next rotation", async () => {
  const file = join(root, "replace.jsonl");
  const rotated = join(root, "replace.1.jsonl");
  await writeFile(rotated, "stale\n");
  const r = row("2026-10-01T10:00:00.000Z", "a1", 40_000, "turn");
  const lineBytes = Buffer.byteLength(`${JSON.stringify(r)}\n`);

  await recordTelemetry(r, file, lineBytes);
  await recordTelemetry(row("2026-10-01T10:00:01.000Z", "a2", 40_000, "turn"), file, lineBytes);

  const old = await readFile(rotated, "utf8");
  assert.ok(!old.includes("stale"));
  assert.ok(old.includes('"a1"'));
});

test("summariseTelemetry counts rows from the rotated file and the current one", async () => {
  const file = join(root, "both.jsonl");
  await writeFile(join(root, "both.1.jsonl"), ROWS.slice(0, 5).map((r) => JSON.stringify(r)).join("\n") + "\n");
  for (const r of ROWS.slice(5)) await recordTelemetry(r, file);

  const summary = await summariseTelemetry(null, file);
  assert.equal(summary.turns, 3);
  assert.equal(summary.sessions, 2);
  assert.equal(summary.tokensAvoided, 120_000);
});

test("summariseTelemetry takes the spend baseline from the rotated file", async () => {
  const file = join(root, "spend-rotated.jsonl");
  const today = "2026-09-20T00:00:00.000Z";
  const baseline = row("2026-09-19T10:00:00.000Z", "a1", 10_000, "turn", { costUsd: 3 });
  await writeFile(join(root, "spend-rotated.1.jsonl"), `${JSON.stringify(baseline)}\n`);
  await recordTelemetry(row("2026-09-20T06:00:00.000Z", "a1", 10_000, "turn", { costUsd: 5 }), file);

  const summary = await summariseTelemetry(null, file, today);
  assert.equal(summary.spendToday, 2);
  assert.equal(summary.spendWeek, 5);
});

test("summariseTelemetry steps the week back whole days from the caller's today, whatever the server's zone", async () => {
  const file = join(root, "spend-week.jsonl");
  // US clocks fall back on 2026-11-01, inside this week; the caller's midnight is 05:00Z.
  const today = "2026-11-05T05:00:00.000Z";
  await recordTelemetry(row("2026-10-30T04:30:00.000Z", "a1", 10_000, "turn", { costUsd: 1 }), file);
  await recordTelemetry(row("2026-11-05T06:00:00.000Z", "a1", 10_000, "turn", { costUsd: 4 }), file);

  // Week start is 2026-10-30T05:00Z exactly, so the 04:30Z row is the baseline.
  const summary = await summariseTelemetry(null, file, today);
  assert.equal(summary.spendWeek, 3);
});
