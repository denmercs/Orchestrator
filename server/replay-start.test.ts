import { test } from "node:test";
import assert from "node:assert/strict";
import type { TelemetryRow } from "./context-telemetry";
import { lastTurn } from "./replay-start";

const row = (agentId: string, event: TelemetryRow["event"], costUsd: number): TelemetryRow => ({
  at: "2026-10-10T00:00:00.000Z",
  agentId,
  provider: "claude",
  step: "review",
  used: 1_000,
  max: 200_000,
  event,
  costUsd,
});

test("lastTurn: the agent's last turn or turn.stopped row, skipping other events and agents", async () => {
  const rows = [row("a1", "turn", 1), row("a1", "turn.stopped", 2), row("a1", "warning", 3), row("b1", "turn", 4)];
  assert.equal((await lastTurn("a1", async () => rows))?.costUsd, 2);
  assert.equal(await lastTurn("c1", async () => rows), null);
});
