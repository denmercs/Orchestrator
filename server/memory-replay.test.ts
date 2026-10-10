import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentCreateConfig } from "../shared/agent-runner";
import type { CorpusRow } from "../shared/replay";
import { stepPrompt } from "../shared/story-method";
import type { TelemetryRow } from "./context-telemetry";
import { mcpScopeFor } from "./mcp-scope";
import { createMemoryReplay, type ReplayPorts } from "./memory-replay";

const row: CorpusRow = {
  initiative: "agent-memory",
  story: "S7",
  title: "Replay past Reviews",
  body: "## Acceptance\n- a judge marks each finding",
  round: 2,
  kind: "failed",
  commit: "abc123",
  base: "base000",
  asOf: "2026-05-01T00:00:00Z",
  findings: ["missing test for parse", "uses any in the loader"],
  plan: "- parse the corpus\n- write rows",
  cycles: "- [x] Cycle 1 — corpus: do it",
};

const config = { provider: "claude", model: "sonnet" } as unknown as AgentCreateConfig;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "memory-replay-"));
  const runDir = join(root, "run1");
  mkdirSync(runDir, { recursive: true });
  const calls = {
    analyze: [] as { root: string; opts: Record<string, unknown> }[],
    workspaces: [] as { id: string; title: string; directory: string }[],
    agents: [] as { workspace: string; input: { title: string; config: unknown; prompt: string; labels: Record<string, string> }; scope: string }[],
    archived: [] as string[],
    removed: [] as string[],
    added: [] as { dir: string; commit: string }[],
    judged: [] as { recorded: string[]; replay: string[] }[],
  };
  const ports: ReplayPorts = {
    paseo: {
      createWorkspace: async (input) => {
        const id = `ws${calls.workspaces.length + 1}`;
        calls.workspaces.push({ id, ...input });
        return { id };
      },
      createAgent: async (workspace, input) => {
        const dir = calls.workspaces.find((w) => w.id === workspace)!.directory;
        calls.agents.push({ workspace, input, scope: mcpScopeFor(dir) });
        return { id: `ag${calls.agents.length}` };
      },
      archiveWorkspace: async (id) => void calls.archived.push(id),
      cancelAgent: async () => undefined,
    },
    git: {
      addWorktree: async (_root, dir, commit) => {
        mkdirSync(dir, { recursive: true });
        calls.added.push({ dir, commit });
      },
      removeWorktree: async (_root, dir) => {
        rmSync(dir, { recursive: true, force: true });
        calls.removed.push(dir);
      },
      changedPaths: async () => ["server/a.ts"],
    },
    analyze: async (r, opts) => void calls.analyze.push({ root: r, opts: opts as Record<string, unknown> }),
    brief: async (_memoryDir, arm) => (arm === "none" ? [] : [`- brief for ${arm}`]),
    judge: async (recorded, replay) => {
      calls.judged.push({ recorded, replay });
      return { matches: [[0, 0]], costUsd: 0.002 };
    },
    telemetry: {
      lastTurn: async (agentId): Promise<TelemetryRow> => ({
        at: "2026-05-02T00:00:00Z",
        agentId,
        provider: "claude",
        step: null,
        used: 1234,
        max: 200000,
        event: "turn",
        costUsd: 0.5,
        explore: { reads: 3, searches: 1, files: 2, chars: 100, edited: false },
      }),
    },
    agentConfig: async () => config,
    installBrief: async () => undefined,
  };
  return { root, runDir, calls, ports };
}

const reviewState = (findings: string) => `## Status\nreview-failed\n\n## Plan\nx\n\n## Review findings\n${findings}\n\n## Preview\n`;

test("replays one corpus row in three arms and records each on its turn end", async () => {
  const { root, runDir, calls, ports } = setup();
  const replay = createMemoryReplay(ports);
  const ids = await replay.runRound({ run: "run1", root, runDir }, row);

  // Memory is built once, as of the row's date, without the story's own findings, away from the repo's memory.
  assert.equal(calls.analyze.length, 1);
  assert.equal(calls.analyze[0].root, root);
  assert.equal(calls.analyze[0].opts.asOf, row.asOf);
  assert.equal(calls.analyze[0].opts.excludeStory, "S7");
  assert.equal(calls.analyze[0].opts.memoryRoot, join(runDir, "memory", "agent-memory-S7"));

  // Three workspaces at the commit, one per arm.
  assert.equal(calls.workspaces.length, 3);
  assert.equal(calls.added.length, 3);
  assert.ok(calls.added.every((a) => a.commit === "abc123"));
  assert.equal(new Set(calls.added.map((a) => a.dir)).size, 3);

  // state.md is seeded with the recovered Plan and Cycles.
  const state = readFileSync(join(calls.added[0].dir, ".harness", "state.md"), "utf8");
  assert.match(state, /## Plan\n- parse the corpus/);
  assert.match(state, /## Cycles\n- \[x\] Cycle 1/);

  // Three agents with the Review prompt, labels, and no MCP servers; only `none` has no brief.
  assert.equal(ids.length, 3);
  assert.equal(calls.agents.length, 3);
  const arms = calls.agents.map((a) => a.input.labels["replay-arm"]).sort();
  assert.deepEqual(arms, ["facts", "facts+corrections", "none"]);
  for (const a of calls.agents) {
    assert.equal(a.scope, "none");
    assert.equal(a.input.config, config);
    assert.deepEqual(
      { ...a.input.labels, "replay-arm": "" },
      {
        kind: "memory-replay",
        "replay-run": "run1",
        "replay-story": "S7",
        "replay-round": "2",
        "replay-arm": "",
        "replay-step": "review",
      },
    );
    const none = a.input.labels["replay-arm"] === "none";
    assert.equal(a.input.prompt.includes("## Memory brief"), !none);
  }
  const noneAgent = calls.agents.find((a) => a.input.labels["replay-arm"] === "none")!;
  const bare = stepPrompt(
    "review",
    { id: "S7", title: row.title, body: row.body, ticketKey: null, ticketUrl: null, storyFile: null, storiesDir: null, phaseLabel: null, phaseTitle: null, architectureFile: null, initiativeTitle: null, initiativeFile: null, branch: "", base: "base000" },
    { round: 2, plan: row.plan },
  );
  assert.equal(noneAgent.input.prompt, bare);
  assert.ok(noneAgent.input.prompt.includes("a judge marks each finding"), "the Review prompt carries the story body");

  // Turn ends: each agent's worktree holds its findings.
  for (const [i, a] of calls.agents.entries()) {
    const dir = calls.workspaces.find((w) => w.id === a.workspace)!.directory;
    writeFileSync(join(dir, ".harness", "state.md"), reviewState(i === 0 ? "- parse has no test\n- naming nit" : "- parse has no test"), "utf8");
    assert.equal(await replay.onTurnEnded({ agentId: ids[i] }), true);
  }

  const lines = readFileSync(join(runDir, "results.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  const first = lines[0];
  assert.equal(first.story, "S7");
  assert.equal(first.round, 2);
  assert.equal(first.arm, calls.agents[0].input.labels["replay-arm"]);
  assert.deepEqual(first.outcome, { caught: ["missing test for parse"], notCaught: ["uses any in the loader"], new: ["naming nit"] });
  assert.deepEqual(first.explore, { reads: 3, searches: 1, files: 2, chars: 100, edited: false });
  assert.deepEqual(first.tokens, { used: 1234, costUsd: 0.5 });
  assert.equal(first.judgeCostUsd, 0.002);

  // New findings go to a checklist for a human.
  const checklist = readFileSync(join(runDir, "new-findings.md"), "utf8");
  assert.match(checklist, /- \[ \] yes \/ no — agent-memory\/S7 r2 .*: naming nit/);

  // Every workspace is archived and its worktree removed.
  assert.deepEqual([...calls.archived].sort(), ["ws1", "ws2", "ws3"]);
  assert.equal(calls.removed.length, 3);
  assert.ok(calls.added.every((a) => !existsSync(a.dir)));
  rmSync(root, { recursive: true, force: true });
});

test("a failed agent start leaks no worktree", async () => {
  const { root, runDir, calls, ports } = setup();
  ports.paseo.createAgent = async () => {
    throw new Error("no agent for you");
  };
  const replay = createMemoryReplay(ports);
  await assert.rejects(replay.runRound({ run: "run1", root, runDir }, row), /no agent for you/);
  assert.equal(calls.removed.length, 3);
  assert.equal(calls.archived.length, 3);
  assert.ok(calls.added.every((a) => !existsSync(a.dir)));
  rmSync(root, { recursive: true, force: true });
});

test("a turn end for an agent it did not start is ignored", async () => {
  const { ports } = setup();
  assert.equal(await createMemoryReplay(ports).onTurnEnded({ agentId: "stranger" }), false);
});

// ---- Cycle 8: cap, error and cleanup paths ----

function fakeTimers() {
  const scheduled: { id: number; fn: () => void; ms: number; live: boolean }[] = [];
  return {
    scheduled,
    set: (fn: () => void, ms: number) => {
      const t = { id: scheduled.length, fn, ms, live: true };
      scheduled.push(t);
      return t;
    },
    clear: (h: unknown) => void ((h as { live: boolean }).live = false),
    // Fires the live timer with this delay.
    fire: (ms: number) => scheduled.filter((t) => t.live && t.ms === ms).forEach((t) => ((t.live = false), t.fn())),
  };
}

const control: CorpusRow = { ...row, story: "S8", round: 1, kind: "control", findings: [] };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const rowsOf = (runDir: string) =>
  readFileSync(join(runDir, "results.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

function withCaps(ports: ReplayPorts) {
  const cancelled: string[] = [];
  ports.paseo.cancelAgent = async (id) => void cancelled.push(id);
  return cancelled;
}

test("replay logs the cap first and puts spent/cap in each agent title", async () => {
  const { root, runDir, calls, ports } = setup();
  withCaps(ports);
  const replay = createMemoryReplay(ports);
  const done = replay.replay([row, control], { run: "run1", root, runDir });
  await tick();
  await tick();
  const first = readFileSync(join(runDir, "run.log"), "utf8").split("\n")[0];
  assert.equal(first, "cost cap $120.00 · 2 rounds × 3 arms · reserve $1.20");
  assert.ok(calls.agents.length > 0 && calls.agents.every((a) => a.input.title.endsWith("$0.00/$120.00")));
  for (let guard = 0; replay.pendingAgents().length || calls.agents.length < 6; guard++) {
    for (const id of replay.pendingAgents()) await replay.onTurnEnded({ agentId: id });
    await tick();
    if (guard > 50) assert.fail("did not finish");
  }
  const result = await done;
  assert.equal(result.started, 6);
  assert.equal(rowsOf(runDir).length, 6);
  rmSync(root, { recursive: true, force: true });
});

test("a round that does not fit is not started", async () => {
  const { root, runDir, calls, ports } = setup();
  withCaps(ports);
  const replay = createMemoryReplay(ports);
  // 3 x 1.20 reserve = 3.60 > 3.00 cap.
  const result = await replay.replay([row], { run: "run1", root, runDir, costCap: 3 });
  assert.equal(calls.agents.length, 0);
  assert.equal(calls.workspaces.length, 0);
  assert.equal(result.stoppedByCap, true);
  assert.match(readFileSync(join(runDir, "run.log"), "utf8"), /^cost cap \$3\.00 · 1 rounds × 3 arms · reserve \$1\.20\n/);
  assert.match(readFileSync(join(runDir, "run.log"), "utf8"), /does not fit/);
  rmSync(root, { recursive: true, force: true });
});

test("reaching the cap cancels in-flight agents and writes stopped rows", async () => {
  const { root, runDir, calls, ports } = setup();
  const cancelled = withCaps(ports);
  const timers = fakeTimers();
  ports.timers = timers;
  const replay = createMemoryReplay(ports);
  const done = replay.replay([row], { run: "run1", root, runDir, costCap: 4, reserve: 1, pollMs: 10 });
  await tick();
  await tick();
  const ids = replay.pendingAgents();
  assert.equal(ids.length, 3);
  // Each agent has spent 0.5 (fake telemetry): 1.5 < 4, the poll leaves them running.
  timers.fire(10);
  await tick();
  assert.equal(replay.pendingAgents().length, 3);
  // Telemetry now reports 2 dollars per agent: 6 >= 4.
  ports.telemetry.lastTurn = async (agentId) => ({ at: "x", agentId, provider: "claude", step: null, used: 1, max: 2, event: "turn", costUsd: 2, explore: null }) as TelemetryRow;
  timers.fire(10);
  const result = await done;
  assert.equal(result.stoppedByCap, true);
  assert.deepEqual([...cancelled].sort(), [...ids].sort());
  const rows = rowsOf(runDir);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.stopped === "cap" && r.outcome === null));
  assert.equal(calls.archived.length, 3);
  assert.ok(calls.added.every((a) => !existsSync(a.dir)));
  rmSync(root, { recursive: true, force: true });
});

test("a finished agent's cost can reach the cap and stop its siblings", async () => {
  const { root, runDir, ports } = setup();
  const cancelled = withCaps(ports);
  ports.telemetry.lastTurn = async (agentId) => ({ at: "x", agentId, provider: "claude", step: null, used: 1, max: 2, event: "turn", costUsd: 2, explore: null }) as TelemetryRow;
  const replay = createMemoryReplay(ports);
  const done = replay.replay([row], { run: "run1", root, runDir, costCap: 4, reserve: 1 });
  await tick();
  await tick();
  const [first, ...rest] = replay.pendingAgents();
  await replay.onTurnEnded({ agentId: first });
  const result = await done;
  assert.equal(result.stoppedByCap, true);
  assert.deepEqual([...cancelled].sort(), [...rest].sort());
  const rows = rowsOf(runDir);
  assert.equal(rows.filter((r) => r.stopped === "cap").length, 2);
  assert.equal(rows.filter((r) => !r.stopped).length, 1);
  rmSync(root, { recursive: true, force: true });
});

test("a failed agent and a 45-minute timeout write error rows and clean up", async () => {
  const { root, runDir, calls, ports } = setup();
  const cancelled = withCaps(ports);
  const timers = fakeTimers();
  ports.timers = timers;
  const replay = createMemoryReplay(ports);
  const done = replay.replay([row], { run: "run1", root, runDir });
  await tick();
  await tick();
  const [a, b, c] = replay.pendingAgents();
  assert.ok(timers.scheduled.some((t) => t.ms === 45 * 60 * 1000));
  await replay.onAgentFailed({ agentId: a, error: "provider crashed" });
  writeFileSync(join(calls.workspaces[1].directory, ".harness", "state.md"), reviewState("- parse has no test"), "utf8");
  await replay.onTurnEnded({ agentId: b });
  timers.fire(45 * 60 * 1000);
  await done;
  const rows = rowsOf(runDir);
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.error === "provider crashed")?.outcome, null);
  assert.ok(rows.some((r) => /timeout after 45 minutes/.test(r.error ?? "")));
  assert.equal(rows.filter((r) => !r.error).length, 1);
  assert.ok(cancelled.includes(a) && cancelled.includes(c) && !cancelled.includes(b));
  assert.equal(calls.archived.length, 3);
  assert.ok(calls.added.every((x) => !existsSync(x.dir)));
  rmSync(root, { recursive: true, force: true });
});

test("a rerun skips done rows, retries cap-stopped ones and removes orphan worktrees", async () => {
  const { root, runDir, calls, ports } = setup();
  withCaps(ports);
  const doneRow = (arm: string, extra: object = {}) => ({ run: "run1", initiative: row.initiative, story: "S7", round: 2, kind: "failed", arm, outcome: null, tokens: { used: 1, costUsd: 0.25 }, judgeCostUsd: 0, ...extra });
  writeFileSync(
    join(runDir, "results.jsonl"),
    [doneRow("none"), doneRow("facts"), doneRow("facts+corrections", { stopped: "cap" })].map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8",
  );
  const orphan = join(runDir, "worktrees", "agent-memory-S7-r2-none");
  mkdirSync(orphan, { recursive: true });
  const replay = createMemoryReplay(ports);
  const done = replay.replay([row], { run: "run1", root, runDir });
  await tick();
  await tick();
  assert.ok(calls.removed.includes(orphan));
  assert.equal(calls.agents.length, 1);
  assert.equal(calls.agents[0].input.labels["replay-arm"], "facts+corrections");
  // Earlier spend ($0.75) shows in the title.
  assert.ok(calls.agents[0].input.title.endsWith("$0.75/$120.00"));
  await replay.onTurnEnded({ agentId: replay.pendingAgents()[0] });
  await done;
  assert.equal(rowsOf(runDir).length, 4);
  rmSync(root, { recursive: true, force: true });
});

test("a bad cost cap is rejected before anything starts", async () => {
  const { root, runDir, calls, ports } = setup();
  withCaps(ports);
  await assert.rejects(createMemoryReplay(ports).replay([row], { run: "run1", root, runDir, costCap: 0 }), /bad cost cap/);
  assert.equal(calls.agents.length, 0);
});

// ---- Round 2 review fixes ----

test("a 'None' findings bullet is not a replay finding", async () => {
  const { root, runDir, calls, ports } = setup();
  withCaps(ports);
  const replay = createMemoryReplay(ports);
  const done = replay.replay([row], { run: "run1", root, runDir });
  await tick();
  await tick();
  for (const id of replay.pendingAgents()) {
    const dir = calls.workspaces.find((w) => w.id === calls.agents[Number(id.slice(2)) - 1].workspace)!.directory;
    writeFileSync(join(dir, ".harness", "state.md"), reviewState("- None\n- No findings.\n- real problem"), "utf8");
    await replay.onTurnEnded({ agentId: id });
  }
  await done;
  assert.deepEqual(calls.judged[0].replay, ["real problem"]);
  rmSync(root, { recursive: true, force: true });
});

test("a rerun retries error rows", async () => {
  const { root, runDir, calls, ports } = setup();
  withCaps(ports);
  const doneRow = (arm: string, extra: object = {}) => ({ run: "run1", initiative: row.initiative, story: "S7", round: 2, kind: "failed", arm, outcome: null, tokens: { used: 1, costUsd: 0 }, judgeCostUsd: 0, ...extra });
  writeFileSync(
    join(runDir, "results.jsonl"),
    [doneRow("none"), doneRow("facts", { error: "git worktree add failed" }), doneRow("facts+corrections")].map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8",
  );
  const replay = createMemoryReplay(ports);
  const done = replay.replay([row], { run: "run1", root, runDir });
  await tick();
  await tick();
  assert.deepEqual(calls.agents.map((a) => a.input.labels["replay-arm"]), ["facts"]);
  await replay.onTurnEnded({ agentId: replay.pendingAgents()[0] });
  await done;
  rmSync(root, { recursive: true, force: true });
});

test("classifier spend while building memory counts against the cap and is logged", async () => {
  const { root, runDir, calls, ports } = setup();
  withCaps(ports);
  ports.analyze = async (r, opts) => {
    calls.analyze.push({ root: r, opts: opts as Record<string, unknown> });
    return { spentUsd: 0.4 };
  };
  const replay = createMemoryReplay(ports);
  const done = replay.replay([row], { run: "run1", root, runDir, costCap: 50 });
  await tick();
  await tick();
  assert.equal(calls.analyze[0].opts.costCap, 50);
  assert.ok(calls.agents[0].input.title.endsWith("$0.40/$50.00"));
  assert.match(readFileSync(join(runDir, "run.log"), "utf8"), /classifier spent \$0\.40/);
  for (const id of replay.pendingAgents()) await replay.onTurnEnded({ agentId: id });
  await done;
  rmSync(root, { recursive: true, force: true });
});

test("a rerun archives replay agents and workspaces the dead plugin left in Paseo", async () => {
  const { root, runDir, calls, ports } = setup();
  const cancelled = withCaps(ports);
  ports.strays = async (run) => (run === "run1" ? [{ agentId: "old1", workspaceId: "wsOld" }, { agentId: "old2", workspaceId: null }] : []);
  const replay = createMemoryReplay(ports);
  const done = replay.replay([row], { run: "run1", root, runDir });
  await tick();
  await tick();
  assert.deepEqual(cancelled, ["old1", "old2"]);
  assert.ok(calls.archived.includes("wsOld"));
  for (const id of replay.pendingAgents()) await replay.onTurnEnded({ agentId: id });
  await done;
  rmSync(root, { recursive: true, force: true });
});
