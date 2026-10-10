// Wiring for the memory replay: the real ports (Paseo, git, analyzer, judge, telemetry) and the corpus reader behind ⌘K.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { AgentCreateConfig } from "../shared/agent-runner";
import type { CorpusRow } from "../shared/replay";
import { installBrief } from "./brief-install";
import { readTelemetry, type TelemetryRow } from "./context-telemetry";
import { defaultApiKey } from "./correction-classifier";
import type { ReplayPorts } from "./memory-replay";
import { haikuJudge } from "./replay-judge";
import { analyze } from "./repo-analyzer";

type PaseoApi = PluginHandlerContext["paseo"];

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync("git", args, { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });

export const REPLAY_RUN = "run";

// The last `turn` row for an agent in the telemetry file, or null.
export async function lastTurn(agentId: string, rows: () => Promise<TelemetryRow[]> = readTelemetry): Promise<TelemetryRow | null> {
  const all = await rows();
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].agentId === agentId && all[i].event === "turn") return all[i];
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
    judge: haikuJudge({ apiKey: defaultApiKey }),
    telemetry: { lastTurn: (agentId) => lastTurn(agentId) },
    agentConfig: () => agentConfig(paseo()),
    installBrief,
  };
}

export const corpusFile = (root: string) => join(root, ".harness", "replay", "corpus.jsonl");

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
