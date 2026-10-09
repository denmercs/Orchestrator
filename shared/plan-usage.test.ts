import assert from "node:assert/strict";
import { test } from "node:test";
import { type PlanUsageRow, planUsageResult, planUsageRows } from "./plan-usage";

// The row for one provider, which must be available.
function availableRow(rows: PlanUsageRow[], provider: string) {
  const row = rows.find((candidate) => candidate.provider === provider);
  assert.equal(row?.state, "available", `${provider} row is available`);
  return row as Extract<PlanUsageRow, { state: "available" }>;
}

// The live Claude entry from `paseo.providers.listUsage()` (2026-10-08), with its times pinned.
const claude = {
  providerId: "claude",
  displayName: "Claude (someone@example.com)",
  status: "available",
  planLabel: "Max",
  fetchedAt: "2026-10-08T14:06:00.000Z",
  windows: [
    { id: "five_hour", label: "Session", usedPct: 39, resetsAt: "2026-10-08T18:00:00.000Z", tone: "ok" },
    { id: "weekly_surface_cowork", label: "Weekly · Cowork", usedPct: 0, resetsAt: "2026-10-12T16:06:00.000Z", tone: "ok" },
  ],
};

const now = new Date("2026-10-08T14:06:00.000Z");

test("Claude's windows become one row: % used and resets in, no run-out", () => {
  const result = planUsageResult.parse({ providers: [claude], error: null });
  const row = availableRow(planUsageRows(result, now), "claude");
  assert.deepEqual(row, {
    provider: "claude",
    name: "Claude",
    state: "available",
    plan: "Max",
    meters: [
      { label: "Session", percent: "39%", amount: null, resets: "resets in 3h 54m", runsOut: null, tone: "default" },
      { label: "Weekly · Cowork", percent: "0%", amount: null, resets: "resets in 4d 2h", runsOut: null, tone: "default" },
    ],
  });
});

test("a window with runsOutAt says when it runs out", () => {
  const result = planUsageResult.parse({
    providers: [
      {
        ...claude,
        windows: [
          { ...claude.windows[0], runsOutAt: "2026-10-08T15:16:00.000Z", tone: "warning" },
        ],
      },
    ],
    error: null,
  });
  const row = availableRow(planUsageRows(result, now), "claude");
  assert.deepEqual(row.meters, [
    {
      label: "Session",
      percent: "39%",
      amount: null,
      resets: "resets in 3h 54m",
      runsOut: "runs out in 1h 10m",
      tone: "warning",
    },
  ]);
});

// The live Cursor entry from `paseo.providers.listUsage()` (2026-10-08): a USD balance, no windows.
const cursor = {
  providerId: "cursor",
  displayName: "Cursor (someone@example.com)",
  status: "available",
  planLabel: "Pro",
  fetchedAt: "2026-10-08T14:06:00.000Z",
  windows: [],
  balances: [
    {
      id: "plan_usage",
      label: "Plan usage",
      used: 569.46,
      limit: 70,
      unit: "usd",
      resetsAt: "2026-11-01T00:00:00.000Z",
      tone: "danger",
    },
  ],
};

test("Cursor's balance becomes a meter: % of the limit, dollars of the limit, daemon tone", () => {
  const result = planUsageResult.parse({ providers: [cursor], error: null });
  const row = availableRow(planUsageRows(result, now), "cursor");
  assert.deepEqual(row, {
    provider: "cursor",
    name: "Cursor",
    state: "available",
    plan: "Pro",
    meters: [
      {
        label: "Plan usage",
        // 569.46 / 70 = 813.5…%, rounded to whole numbers.
        percent: "814%",
        amount: "$569.46 of $70",
        resets: "resets in 23d 9h",
        runsOut: null,
        tone: "danger",
      },
    ],
  });
});

test("a balance with no limit shows the dollars only, no %", () => {
  const result = planUsageResult.parse({
    providers: [{ ...cursor, balances: [{ ...cursor.balances[0], limit: null, resetsAt: null, tone: "default" }] }],
    error: null,
  });
  const row = availableRow(planUsageRows(result, now), "cursor");
  assert.deepEqual(row.meters, [
    { label: "Plan usage", percent: null, amount: "$569.46", resets: null, runsOut: null, tone: "default" },
  ]);
});

const unavailable = (provider: string, name: string) => ({ provider, name, state: "unavailable" });

test("always Claude, Kiro, Cursor in that order; Kiro absent is unavailable, Codex is ignored", () => {
  const codex = { ...claude, providerId: "codex", displayName: "Codex" };
  const result = planUsageResult.parse({ providers: [cursor, codex, claude], error: null });
  const rows = planUsageRows(result, now);
  assert.deepEqual(
    rows.map((row) => [row.provider, row.state]),
    [
      ["claude", "available"],
      ["kiro", "unavailable"],
      ["cursor", "available"],
    ],
  );
  assert.deepEqual(rows[1], unavailable("kiro", "Kiro"));
});

test("providers: null (the daemon call failed) makes every row unavailable", () => {
  const result = planUsageResult.parse({ providers: null, error: "Update the host to list provider usage." });
  assert.deepEqual(planUsageRows(result, now), [
    unavailable("claude", "Claude"),
    unavailable("kiro", "Kiro"),
    unavailable("cursor", "Cursor"),
  ]);
});

for (const status of ["error", "unavailable"] as const) {
  test(`a provider with status "${status}" is unavailable, whatever numbers it carries`, () => {
    const result = planUsageResult.parse({ providers: [{ ...claude, status }], error: null });
    assert.deepEqual(planUsageRows(result, now)[0], unavailable("claude", "Claude"));
  });
}

test("a window with usedPct: null and no balances is unavailable, never a number computed from elsewhere", () => {
  const result = planUsageResult.parse({
    providers: [
      {
        ...claude,
        windows: [{ ...claude.windows[0], usedPct: null, remainingPct: 61 }],
      },
    ],
    error: null,
  });
  assert.deepEqual(planUsageRows(result, now)[0], unavailable("claude", "Claude"));
});

test("a window with usedPct: null next to one with a number shows no % for it", () => {
  const result = planUsageResult.parse({
    providers: [{ ...claude, windows: [{ ...claude.windows[0], usedPct: null, remainingPct: 61 }, claude.windows[1]] }],
    error: null,
  });
  const row = availableRow(planUsageRows(result, now), "claude");
  assert.deepEqual(
    row.meters.map((meter) => meter.percent),
    [null, "0%"],
  );
});
