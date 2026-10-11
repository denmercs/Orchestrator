// The memory replay runner: replays one past Review round in three arms (no brief, facts, facts + corrections).
// Everything outside the process is a port, so the runner is tested with fakes. Cap, timeout and orphan cleanup
// (Cycle 8) slot in around `runRound` and `onTurnEnded`; `finishArm` is the one place a worktree is removed.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentCreateConfig } from "../shared/agent-runner";
import { readMemory, type Memory } from "./memory";
import {
  ARMS,
  armBrief,
  fits,
  newFindingsLines,
  outcomeOf,
  pairKey,
  replayQueue,
  type Arm,
  type CorpusRow,
  type Outcome,
} from "./replay";
import { briefTag } from "./brief-install";
import type { TelemetryRow } from "./context-telemetry";
import type { Judge } from "./replay-judge";
import { withMcpScope } from "./mcp-scope";
import { readSection, seedState, stepPrompt, type StoryContext } from "../shared/story-method";
import type { analyze as analyzeRepo } from "./repo-analyzer";

export const REPLAY_KIND = "memory-replay";
export const DEFAULT_COST_CAP_USD = 120;
export const DEFAULT_RESERVE_USD = 1.2;
export const AGENT_TIMEOUT_MS = 45 * 60 * 1000;
const POLL_MS = 30_000;

// Worktree source finding (Cycle 7): the protocol types `baseBranch` as a plain string documented as a "base ref",
// but the daemon that resolves it is not in node_modules, so a sha is unconfirmed. The runner therefore uses a detached
// `git worktree add` and a `directory` workspace, which works for any commit.
export type ReplayPorts = {
  paseo: {
    createWorkspace(input: { title: string; directory: string }): Promise<{ id: string }>;
    createAgent(
      workspaceId: string,
      input: { title: string; config: AgentCreateConfig; prompt: string; labels: Record<string, string> },
    ): Promise<{ id: string }>;
    archiveWorkspace(id: string): Promise<void>;
    cancelAgent(id: string): Promise<void>;
  };
  git: {
    addWorktree(root: string, dir: string, commit: string): Promise<void>;
    removeWorktree(root: string, dir: string): Promise<void>;
    changedPaths(root: string, base: string, commit: string): Promise<string[]>;
  };
  analyze: (root: string, opts: Parameters<typeof analyzeRepo>[1]) => Promise<{ spentUsd?: number } | void>;
  // Replay agents of the run still alive in Paseo, left by a plugin that died mid-run. Optional: without it only worktrees are swept.
  strays?: (run: string) => Promise<{ agentId: string; workspaceId: string | null }[]>;
  // The brief for one arm, from the memory built under `memoryRoot`. Defaults to `armBrief` over `readMemory`.
  brief?: (memoryRoot: string, arm: Arm, paths: string[]) => Promise<string[]>;
  judge: Judge;
  telemetry: { lastTurn(agentId: string): Promise<TelemetryRow | null> };
  // The loop's Review profile (`loadStepConfig(…, "review", …)`).
  agentConfig: () => Promise<AgentCreateConfig>;
  installBrief: (worktree: string, tag: string) => Promise<void>;
  // Injectable timers so tests need no real waiting. Defaults to the global ones.
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  now?: () => Date;
};

export type RunContext = { run: string; root: string; runDir: string };

export type ReplayOptions = RunContext & {
  costCap?: number;
  reserve?: number;
  timeoutMs?: number;
  pollMs?: number;
};

export type ResultRow = {
  run: string;
  initiative: string;
  story: string;
  round: number;
  kind: CorpusRow["kind"];
  arm: Arm;
  outcome: Outcome | null;
  explore: TelemetryRow["explore"] | null;
  tokens: { used: number | null; costUsd: number | null };
  judgeCostUsd: number;
  marker: string | null;
  plan: boolean;
  at: string;
  stopped?: "cap";
  error?: string;
};

type Pending = {
  ctx: RunContext;
  row: CorpusRow;
  arm: Arm;
  workspaceId: string;
  dir: string;
  timer: unknown;
  settled: Promise<void>;
  settle: () => void;
};

type Ending = { stopped?: "cap"; error?: string };

const usd = (n: number) => `$${n.toFixed(2)}`;

const readText = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

function withSection(state: string, heading: string, body: string): string {
  const text = body.trim();
  if (!text) return state;
  return state.replace(new RegExp(`^(##[ \\t]+${heading}[ \\t]*\\n)`, "m"), `$1${text}\n`);
}

function findingsOf(state: string): string[] {
  return readSection(state, "Review findings")
    .split("\n")
    .map((line) => /^\s*[-*]\s+(.+)$/.exec(line)?.[1]?.trim() ?? "")
    .filter((text) => text && !/^\W*(none|no (new )?findings?|n\/a)\W*$/i.test(text));
}

export function createMemoryReplay(ports: ReplayPorts) {
  const pending = new Map<string, Pending>();
  const memories = new Map<string, Promise<string>>();
  const now = ports.now ?? (() => new Date());
  const timers = ports.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as NodeJS.Timeout) };
  let spentDone = 0; // dollars in rows written so far, this run and earlier ones
  let cap: number | null = null;
  let timeoutMs = AGENT_TIMEOUT_MS;
  let capping = false;
  const briefOf =
    ports.brief ?? (async (dir: string, arm: Arm, paths: string[]) => armBrief(readMemory(dir) as Memory, arm, paths));

  // Memory for the story, built once and shared by its rounds and arms.
  function memoryFor(ctx: RunContext, row: CorpusRow): Promise<string> {
    const key = `${row.initiative}-${row.story}`;
    let built = memories.get(`${ctx.run}/${key}`);
    if (!built) {
      const memoryRoot = join(ctx.runDir, "memory", key);
      mkdirSync(memoryRoot, { recursive: true });
      // Classifier spend on a cache miss counts against the cap, and analyze gets only what is left of it.
      const left = Math.max(0, (cap ?? DEFAULT_COST_CAP_USD) - spentDone);
      built = ports
        .analyze(ctx.root, { asOf: row.asOf, excludeStory: row.story, memoryRoot, costCap: left })
        .then((result) => {
          const spent = (result && result.spentUsd) || 0;
          spentDone += spent;
          if (spent > 0) log(ctx, `memory for ${row.story}: classifier spent ${usd(spent)}`);
          return memoryRoot;
        });
      memories.set(`${ctx.run}/${key}`, built);
      built.catch(() => memories.delete(`${ctx.run}/${key}`));
    }
    return built;
  }

  // The one place a replay workspace goes away: archive it, then remove its worktree. Neither may throw.
  async function release(ctx: RunContext, workspaceId: string | null, dir: string) {
    if (workspaceId) await ports.paseo.archiveWorkspace(workspaceId).catch(() => undefined);
    await ports.git.removeWorktree(ctx.root, dir).catch(() => undefined);
  }

  async function startArm(ctx: RunContext, row: CorpusRow, arm: Arm, memoryRoot: string, paths: string[]): Promise<string> {
    const dir = join(ctx.runDir, "worktrees", `${row.initiative}-${row.story}-r${row.round}-${arm.replace("+", "-")}`);
    let workspaceId: string | null = null;
    try {
      await ports.git.addWorktree(ctx.root, dir, row.commit);
      workspaceId = (await ports.paseo.createWorkspace({ title: `replay ${row.story} r${row.round} ${arm}`, directory: dir })).id;

      const story: StoryContext = {
        id: row.story,
        title: row.title || row.story,
        body: row.body ?? "",
        ticketKey: null,
        ticketUrl: null,
        storyFile: null,
        storiesDir: null,
        phaseLabel: null,
        phaseTitle: null,
        architectureFile: null,
        initiativeTitle: null,
        initiativeFile: null,
        branch: "",
        base: row.base,
      };
      mkdirSync(join(dir, ".harness"), { recursive: true });
      const state = withSection(withSection(seedState(story), "Plan", row.plan), "Cycles", row.cycles);
      writeFileSync(join(dir, ".harness", "state.md"), state, "utf8");
      await ports.installBrief(dir, briefTag("review", row.round)).catch((error) => console.warn("replay: install brief", error));

      const brief = await briefOf(memoryRoot, arm, paths);
      const prompt = stepPrompt("review", story, { round: row.round, plan: row.plan, ...(brief.length ? { brief } : {}) });
      const config = await ports.agentConfig();
      const labels = {
        kind: REPLAY_KIND,
        "replay-run": ctx.run,
        "replay-story": row.story,
        "replay-round": String(row.round),
        "replay-arm": arm,
        "replay-step": "review",
      };
      const agent = await withMcpScope(dir, "none", () =>
        ports.paseo.createAgent(workspaceId!, {
          title: `${`replay ${row.story} r${row.round} · ${arm}`.slice(0, 44)}${cap === null ? "" : ` ${usd(spentDone)}/${usd(cap)}`}`,
          config,
          prompt,
          labels,
        }),
      );
      let settle = () => {};
      const settled = new Promise<void>((resolve) => (settle = resolve));
      const timer = timers.set(() => void endAgent(agent.id, { error: `timeout after ${Math.round(timeoutMs / 60000)} minutes` }, true), timeoutMs);
      pending.set(agent.id, { ctx, row, arm, workspaceId, dir, timer, settled, settle });
      return agent.id;
    } catch (error) {
      await release(ctx, workspaceId, dir);
      throw error;
    }
  }

  function writeRow(ctx: RunContext, row: CorpusRow, arm: Arm, fields: Partial<ResultRow>): ResultRow {
    const result: ResultRow = {
      run: ctx.run,
      initiative: row.initiative,
      story: row.story,
      round: row.round,
      kind: row.kind,
      arm,
      outcome: null,
      explore: null,
      tokens: { used: null, costUsd: null },
      judgeCostUsd: 0,
      marker: null,
      plan: row.plan.trim() !== "",
      at: now().toISOString(),
      ...fields,
    };
    mkdirSync(ctx.runDir, { recursive: true });
    appendFileSync(join(ctx.runDir, "results.jsonl"), `${JSON.stringify(result)}\n`, "utf8");
    spentDone += (result.tokens.costUsd ?? 0) + result.judgeCostUsd;
    const lines = newFindingsLines(result);
    if (lines.length) appendFileSync(join(ctx.runDir, "new-findings.md"), `${lines.join("\n")}\n`, "utf8");
    return result;
  }

  function log(ctx: RunContext, line: string) {
    mkdirSync(ctx.runDir, { recursive: true });
    appendFileSync(join(ctx.runDir, "run.log"), `${line}\n`, "utf8");
  }

  // Starts one Review agent per arm for the row. A failing arm is cleaned up and gets an error row; the others still start.
  async function launch(ctx: RunContext, row: CorpusRow, arms: Arm[]): Promise<{ ids: string[]; error: unknown }> {
    mkdirSync(ctx.runDir, { recursive: true });
    let memoryRoot: string;
    try {
      memoryRoot = await memoryFor(ctx, row);
    } catch (error) {
      for (const arm of arms) writeRow(ctx, row, arm, { error: errorText(error) });
      return { ids: [], error };
    }
    const paths = await ports.git.changedPaths(ctx.root, row.base, row.commit).catch(() => [] as string[]);
    const results = await Promise.allSettled(arms.map((arm) => startArm(ctx, row, arm, memoryRoot, paths)));
    const ids: string[] = [];
    let error: unknown = null;
    results.forEach((r, i) => {
      if (r.status === "fulfilled") ids.push(r.value);
      else {
        error ??= r.reason;
        writeRow(ctx, row, arms[i], { error: errorText(r.reason) });
      }
    });
    return { ids, error };
  }

  async function runRound(ctx: RunContext, row: CorpusRow, arms: Arm[] = ARMS): Promise<string[]> {
    const { ids, error } = await launch(ctx, row, arms);
    if (error) throw error;
    return ids;
  }

  // Ends one agent: records its row (a normal one, or stopped/error), then removes its workspace. False for a stranger.
  async function endAgent(agentId: string, ending: Ending, cancel: boolean): Promise<boolean> {
    const job = pending.get(agentId);
    if (!job) return false;
    pending.delete(agentId);
    timers.clear(job.timer);
    const { ctx, row, arm } = job;
    try {
      if (cancel) await ports.paseo.cancelAgent(agentId).catch(() => undefined);
      const turn = await ports.telemetry.lastTurn(agentId).catch(() => null);
      const fields: Partial<ResultRow> = {
        explore: turn?.explore ?? null,
        tokens: { used: turn?.used ?? null, costUsd: turn?.costUsd ?? null },
        ...ending,
      };
      if (!ending.stopped && !ending.error) {
        const state = readText(join(job.dir, ".harness", "state.md"));
        const replayFindings = findingsOf(state);
        let matches: [number, number][] | null = [];
        if (row.kind === "failed" && row.findings.length && replayFindings.length) {
          try {
            const verdict = await ports.judge(row.findings, replayFindings);
            matches = verdict.matches;
            fields.judgeCostUsd = verdict.costUsd;
          } catch (error) {
            console.warn("replay: judge", error);
            matches = null;
          }
        }
        fields.outcome = outcomeOf(row.findings, replayFindings, matches);
        fields.marker = /^##\s+Status\s*\n\s*`?([^\n`]+)/m.exec(state)?.[1]?.trim() ?? null;
      }
      writeRow(ctx, row, arm, fields);
    } finally {
      await release(ctx, job.workspaceId, job.dir);
      job.settle();
    }
    if (cap !== null) await checkCap();
    return true;
  }

  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

  // Dollars spent so far: finished rows plus what the in-flight agents' telemetry says they have used.
  async function spentNow(): Promise<number> {
    let live = 0;
    for (const id of pending.keys()) live += (await ports.telemetry.lastTurn(id).catch(() => null))?.costUsd ?? 0;
    return spentDone + live;
  }

  // At the cap, cancel everything in flight; each gets a `stopped: "cap"` row and its worktree is removed.
  async function checkCap(): Promise<void> {
    if (cap === null || capping || pending.size === 0) return;
    const spent = await spentNow();
    if (spent < cap) return;
    capping = true;
    try {
      const first = [...pending.values()][0];
      if (first) log(first.ctx, `cost cap reached: ${usd(spent)} of ${usd(cap)}, cancelling ${pending.size} agent(s)`);
      await Promise.all([...pending.keys()].map((id) => endAgent(id, { stopped: "cap" }, true)));
    } finally {
      capping = false;
    }
  }

  async function onTurnEnded(event: { agentId: string }): Promise<boolean> {
    return endAgent(event.agentId, {}, false);
  }

  async function onAgentFailed(event: { agentId: string; error?: string }): Promise<boolean> {
    return endAgent(event.agentId, { error: event.error || "agent failed" }, true);
  }

  function doneKeys(ctx: RunContext): Set<string> {
    const done = new Set<string>();
    for (const line of readText(join(ctx.runDir, "results.jsonl")).split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as ResultRow;
        if (r.stopped || r.error) continue; // cut off by the cap or failed to run: a rerun picks it up again
        done.add(pairKey(r, r.arm));
      } catch {
        // a torn line is not a done row
      }
    }
    return done;
  }

  function spentBefore(ctx: RunContext): number {
    let sum = 0;
    for (const line of readText(join(ctx.runDir, "results.jsonl")).split("\n")) {
      try {
        const r = JSON.parse(line) as ResultRow;
        sum += (r.tokens?.costUsd ?? 0) + (r.judgeCostUsd ?? 0);
      } catch {
        // skip
      }
    }
    return sum;
  }

  // Drives the corpus: logs the cap, removes orphan worktrees, skips done pairs, runs one round at a time while it fits.
  async function replay(corpus: CorpusRow[], opts: ReplayOptions): Promise<{ rounds: number; started: number; stoppedByCap: boolean }> {
    const costCap = opts.costCap ?? DEFAULT_COST_CAP_USD;
    const reserve = opts.reserve ?? DEFAULT_RESERVE_USD;
    if (!Number.isFinite(costCap) || costCap <= 0) throw new Error(`replay: bad cost cap ${String(opts.costCap)}`);
    const ctx: RunContext = { run: opts.run, root: opts.root, runDir: opts.runDir };
    cap = costCap;
    timeoutMs = opts.timeoutMs ?? AGENT_TIMEOUT_MS;
    spentDone = spentBefore(ctx);
    const queue = replayQueue(corpus, doneKeys(ctx));
    log(ctx, `cost cap ${usd(costCap)} · ${queue.length} rounds × ${ARMS.length} arms · reserve ${usd(reserve)}`);

    const live = new Set([...pending.values()].map((p) => p.dir));
    const worktrees = join(ctx.runDir, "worktrees");
    if (existsSync(worktrees)) {
      for (const name of readdirSync(worktrees)) {
        const dir = join(worktrees, name);
        if (live.has(dir)) continue;
        await ports.git.removeWorktree(ctx.root, dir).catch(() => undefined);
        log(ctx, `removed orphan worktree ${name}`);
      }
    }

    for (const stray of (await ports.strays?.(ctx.run).catch(() => [])) ?? []) {
      if (pending.has(stray.agentId)) continue;
      await ports.paseo.cancelAgent(stray.agentId).catch(() => undefined);
      if (stray.workspaceId) await ports.paseo.archiveWorkspace(stray.workspaceId).catch(() => undefined);
      log(ctx, `archived stray replay agent ${stray.agentId}`);
    }

    let started = 0;
    let stoppedByCap = false;
    for (const { row, arms } of queue) {
      const spent = await spentNow();
      if (!fits(spent, reserve, costCap, arms.length)) {
        log(ctx, `stopping: ${row.story} r${row.round} does not fit (${usd(spent)} spent + ${arms.length} × ${usd(reserve)} reserve > ${usd(costCap)} cap)`);
        stoppedByCap = true;
        break;
      }
      const { ids, error } = await launch(ctx, row, arms);
      if (error) log(ctx, `${row.story} r${row.round}: ${errorText(error)}`);
      started += ids.length;
      const settled = Promise.all(ids.map((id) => pending.get(id)?.settled));
      let poll: unknown;
      let polling = true;
      const tick = () => {
        if (polling) poll = timers.set(() => void checkCap().finally(tick), opts.pollMs ?? POLL_MS);
      };
      tick();
      try {
        await settled;
      } finally {
        polling = false;
        timers.clear(poll);
      }
      if ((await spentNow()) >= costCap) {
        stoppedByCap = true;
        log(ctx, `cost cap reached: ${usd(spentDone)} of ${usd(costCap)}`);
        break;
      }
    }
    return { rounds: queue.length, started, stoppedByCap };
  }

  return { runRound, replay, onTurnEnded, onAgentFailed, pendingAgents: () => [...pending.keys()] };
}
