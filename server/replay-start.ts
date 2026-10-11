// Wiring for the memory replay: the real ports (Paseo, git, analyzer, judge, telemetry) and the corpus reader behind ⌘K.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { AgentCreateConfig } from "../shared/agent-runner";
import { ARMS, type Arm, type CorpusRow } from "./replay";
import { installBrief } from "./brief-install";
import { readTelemetry, type TelemetryRow } from "./context-telemetry";
import type { ReplayPorts } from "./memory-replay";
import { haikuJudge } from "./replay-judge";
import { analyze } from "./repo-analyzer";

type PaseoApi = PluginHandlerContext["paseo"];

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync("git", args, { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });

// The run a replay writes to when `.harness/replay/run-name` names none.
export const REPLAY_RUN = "run";

// The last `turn` or `turn.stopped` row for an agent in the telemetry file, or null. A failed replay agent's
// last turn is `turn.stopped`, and its result row still needs that turn's cost and explore count.
export async function lastTurn(agentId: string, rows: () => Promise<TelemetryRow[]> = readTelemetry): Promise<TelemetryRow | null> {
  const all = await rows();
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].agentId === agentId && (all[i].event === "turn" || all[i].event === "turn.stopped")) return all[i];
  }
  return null;
}

export function realReplayPorts(getPaseo: () => PaseoApi | null, agentConfig: (paseo: PaseoApi) => Promise<AgentCreateConfig>): ReplayPorts {
  const paseo = () => {
    const api = getPaseo();
    if (!api) throw new Error("Paseo is not connected yet: run the replay from the command center.");
    return api;
  };
  return {
    paseo: {
      async createWorkspace({ title, directory }) {
        const created = await paseo().workspaces.create({ title, source: { kind: "directory", path: directory } });
        return { id: created.id };
      },
      createAgent: (workspaceId, input) => paseo().workspaces.ref(workspaceId).agents.create(input),
      archiveWorkspace: async (id) => void (await paseo().workspaces.archive(id)),
      // The plugin API has no cancel; archiving the agent ends its session, and its workspace is archived right after.
      cancelAgent: async (id) => void (await paseo().agents.ref(id).archive()),
    },
    async strays(run) {
      const listed = await paseo().agents.list({ filter: { includeArchived: false }, page: { limit: 200 } });
      return listed.entries
        .map((entry) => entry.agent)
        .filter((agent) => agent.labels?.kind === "memory-replay" && agent.labels["replay-run"] === run)
        .map((agent) => ({ agentId: agent.id, workspaceId: agent.workspaceId ?? null }));
    },
    git: {
      async addWorktree(root, dir, commit) {
        await git(root, ["worktree", "add", "--detach", dir, commit]);
      },
      async removeWorktree(root, dir) {
        await git(root, ["worktree", "remove", "--force", dir]).catch(() => undefined);
        await git(root, ["worktree", "prune"]).catch(() => undefined);
      },
      async changedPaths(root, base, commit) {
        const { stdout } = await git(root, ["diff", "--name-only", `${base}...${commit}`]);
        return stdout.split("\n").filter(Boolean);
      },
    },
    analyze: (root, opts) => analyze(root, opts),
    judge: haikuJudge(),
    telemetry: { lastTurn: (agentId) => lastTurn(agentId) },
    agentConfig: () => agentConfig(paseo()),
    installBrief,
  };
}

export const corpusFile = (root: string) => join(root, ".harness", "replay", "corpus.jsonl");

export const costCapFile = (root: string) => join(root, ".harness", "replay", "cost-cap");

// The cap (US dollars) that `corpus.mjs --cap` left next to the corpus; undefined when absent or not a positive number.
export function readCostCap(root: string): number | undefined {
  try {
    const cap = Number(readFileSync(costCapFile(root), "utf8").trim());
    return Number.isFinite(cap) && cap > 0 ? cap : undefined;
  } catch {
    return undefined;
  }
}

export const runNameFile = (root: string) => join(root, ".harness", "replay", "run-name");

// The run named in `.harness/replay/run-name`, so a replay that measures something new gets its own folder.
// REPLAY_RUN when absent or empty; a name that is not one plain path segment throws.
export function readRunName(root: string): string {
  let name: string;
  try {
    name = readFileSync(runNameFile(root), "utf8").trim();
  } catch {
    return REPLAY_RUN;
  }
  if (!name) return REPLAY_RUN;
  if (!/^[A-Za-z0-9][\w.-]*$/.test(name)) throw new Error(`${runNameFile(root)}: "${name}" is not a plain folder name`);
  return name;
}

export const armsFile = (root: string) => join(root, ".harness", "replay", "arms");

// The arms named in `.harness/replay/arms` (whitespace-separated), in ARMS order; undefined when absent or naming none.
// An unknown name throws, so a typo can't quietly drop an arm from the run.
export function readArms(root: string): Arm[] | undefined {
  let text: string;
  try {
    text = readFileSync(armsFile(root), "utf8");
  } catch {
    return undefined;
  }
  const names = text.split(/\s+/).filter(Boolean);
  const unknown = names.filter((n) => !(ARMS as string[]).includes(n));
  if (unknown.length) throw new Error(`${armsFile(root)}: unknown arm ${unknown.join(", ")} (known: ${ARMS.join(", ")})`);
  const arms = ARMS.filter((arm) => names.includes(arm));
  return arms.length ? arms : undefined;
}

// The corpus rows, keeping every failed round and the first `controls` control rounds (all of them when unset).
export function readCorpus(root: string, controls?: number): CorpusRow[] {
  const file = corpusFile(root);
  if (!existsSync(file)) {
    throw new Error(`No replay corpus at ${file}. Build it first: node docs/telemetry/agent-memory/corpus.mjs (run from ${root}).`);
  }
  const rows: CorpusRow[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as CorpusRow);
    } catch {
      // a torn line is skipped
    }
  }
  if (rows.length === 0) throw new Error(`The replay corpus ${file} has no rows.`);
  if (controls === undefined) return rows;
  let kept = 0;
  return rows.filter((row) => row.kind === "failed" || kept++ < controls);
}
