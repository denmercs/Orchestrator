import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ContextConfig } from "../shared/context";
import type { TelemetryRow } from "./context-telemetry";
import type { LiveSession } from "./context-watch";
import { loadStoryContext, type StoryContextDeps } from "./story-context";

let repo: string;

before(async () => {
  repo = await mkdtemp(join(tmpdir(), "orchestrator-story-context-"));
  const init = join(repo, ".harness", "initiatives", "redesign");
  await mkdir(join(init, "phases", "1-first", "stories"), { recursive: true });
  await mkdir(join(init, "phases", "2-second", "stories"), { recursive: true });
  await writeFile(join(init, "initiative.md"), "---\ntracker: local\n---\n\n# Initiative: Redesign\n");
  await writeFile(join(init, "phases", "1-first", "stories", "1-idle.md"), "---\nid: S1\nstatus: todo\n---\n");
  await writeFile(
    join(init, "phases", "2-second", "stories", "3-busy.md"),
    "---\nid: S3\nstatus: implementing\nagent: a2\n---\n",
  );
});

after(async () => {
  await rm(repo, { recursive: true, force: true });
});

const LABELS = { "loop-step": "implement", "loop-cycle": "2", "loop-story": "S3", "loop-initiative": "redesign" };

function live(session: LiveSession | null): StoryContextDeps["live"] {
  return async (agentId) => (session && session.agentId === agentId ? session : null);
}

function row(agentId: string, event: TelemetryRow["event"], used: number, extra: Partial<TelemetryRow> = {}): TelemetryRow {
  return {
    at: "2026-10-08T10:00:00.000Z",
    agentId,
    provider: "claude",
    step: "implement",
    used,
    max: 200_000,
    event,
    cycle: 2,
    story: "S3",
    initiative: "redesign",
    ...extra,
  };
}

const ROWS: TelemetryRow[] = [
  row("a0", "turn", 50_000, { step: "plan", cycle: null }),
  row("a1", "turn", 60_000, { costUsd: 0.5 }),
  // a1 handed off fresh to a2 on the same step: session 2.
  row("a2", "compact.fresh", 20_000, { preTokens: 160_000 }),
  row("a2", "turn", 20_000),
  row("a2", "compact.native", 30_000, { preTokens: 140_000 }),
  // Costs are cumulative per session: a2's last one counts.
  row("a2", "turn", 30_000, { costUsd: 0.25 }),
  row("a2", "turn", 40_000, { costUsd: 0.75 }),
  row("a2", "turn", 50_000, { costUsd: 1.25 }),
];

const HALF = { warn: 50, act: 75 } as const;
const CONFIG: ContextConfig = {
  default: { ...HALF, mode: "fresh" },
  plan: { ...HALF, mode: "fresh" },
  implement: { ...HALF, mode: "compact" },
  review: { ...HALF, mode: "fresh" },
  autoCompact: true,
};

function deps(session: LiveSession | null, rows: TelemetryRow[] = ROWS, config: ContextConfig = CONFIG): StoryContextDeps {
  return { live: live(session), rows: async () => rows, policy: async () => config };
}

const SESSION: LiveSession = {
  agentId: "a2",
  reading: { used: 50_000, max: 200_000, level: "ok", capability: "full", strategy: "native" },
  labels: LABELS,
  split: { system: 10_000, toolChars: 40_000 },
};

test("a story with no agent has no context", async () => {
  assert.equal(await loadStoryContext({ repo, initiative: "redesign", storyId: "S1" }, deps(SESSION)), null);
});

test("a story whose agent is gone has no context", async () => {
  assert.equal(await loadStoryContext({ repo, initiative: "redesign", storyId: "S3" }, deps(null)), null);
});

test("a live agent gives the panel, found across phases", async () => {
  assert.deepEqual(await loadStoryContext({ repo, initiative: "redesign", storyId: "S3" }, deps(SESSION)), {
    agentId: "a2",
    step: "implement",
    used: 50_000,
    max: 200_000,
    percent: 25,
    level: "ok",
    session: 2,
    compactions: 1,
    burn: 10_000,
    turnsToAct: 10,
    markers: {
      warn: { tokens: 100_000, percent: 50 },
      act: { tokens: 150_000, percent: 75, word: "compact" },
    },
    split: { system: 10_000, conversation: 30_000, tool: 10_000 },
    costUsd: 1.75,
  });
});

test("the markers read the step's percent of the window, and a fresh step says hand off", async () => {
  const config: ContextConfig = {
    ...CONFIG,
    implement: { warn: 60, act: 80, mode: "compact" },
    plan: { warn: 20, act: 40, mode: "fresh" },
  };
  const input = { repo, initiative: "redesign", storyId: "S3" };
  const implement = await loadStoryContext(input, deps(SESSION, ROWS, config));
  assert.deepEqual(implement?.markers, {
    warn: { tokens: 120_000, percent: 60 },
    act: { tokens: 160_000, percent: 80, word: "compact" },
  });
  const plan = await loadStoryContext(
    input,
    deps({ ...SESSION, labels: { ...LABELS, "loop-step": "plan" } }, ROWS, config),
  );
  assert.deepEqual(plan?.markers, {
    warn: { tokens: 40_000, percent: 20 },
    act: { tokens: 80_000, percent: 40, word: "hand off" },
  });
});

test("cost so far is null when no row of the story has a cost", async () => {
  const rows = ROWS.map(({ costUsd: _cost, ...rest }) => rest);
  const context = await loadStoryContext({ repo, initiative: "redesign", storyId: "S3" }, deps(SESSION, rows));
  assert.equal(context?.costUsd, null);
});

test("a bad initiative slug throws", async () => {
  await assert.rejects(loadStoryContext({ repo, initiative: "../etc", storyId: "S3" }, deps(SESSION)));
});
