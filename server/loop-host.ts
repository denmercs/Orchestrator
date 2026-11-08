import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import type { AgentCreateConfig } from "../shared/agent-runner";
import type { PlanUsageResult } from "../shared/plan-usage";
import { readPlanUsage } from "./plan-usage";

type PaseoApi = PluginHandlerContext["paseo"];

// What the initiative loop needs from a step session when it refreshes one.
export type LoopSession = {
  id: string;
  status?: string;
  archivedAt?: string;
  lastError?: string;
  labels: Record<string, string>;
  activeTurn?: { turnId: string; startedAt: string | null } | null;
  lastUsage?: { totalCostUsd?: number };
};

export type StepAgentCreate = {
  title: string;
  config: AgentCreateConfig;
  prompt: string;
  labels: Record<string, string>;
};

export type StoryWorkspaceCreate = {
  title: string;
  repoRoot: string;
  projectId?: string;
  baseBranch: string;
  branchName: string;
  worktreeSlug: string;
};

export type StoryWorkspace = {
  id: string;
  directory: string;
};

export type LoopProject = {
  projectId: string;
  projectRootPath: string;
};

export type SendToStepOptions = {
  activeTurnBehavior?: "steer" | "interrupt";
};

// Host port for the initiative loop: agent and workspace actions the loop drives, not Paseo types.
export type LoopHost = {
  listStepAgents(): Promise<LoopSession[]>;
  // null when the session is gone; undefined when the host could not answer (try again later).
  refreshSession(agentId: string): Promise<LoopSession | null | undefined>;
  sendToStep(agentId: string, text: string, options?: SendToStepOptions): Promise<void>;
  timelineTail(
    agentId: string,
    options: { limit: number },
  ): Promise<{ entries: unknown[]; error: string | null } | null>;
  startStepAgent(workspaceId: string, input: StepAgentCreate): Promise<{ id: string }>;
  refreshStoryWorkspace(workspaceId: string): Promise<{ directory: string } | null>;
  createStoryWorkspace(input: StoryWorkspaceCreate): Promise<StoryWorkspace>;
  listProjects(): Promise<LoopProject[]>;
  archiveStoryWorkspace(workspaceId: string): Promise<void>;
  readPlanUsage(): Promise<PlanUsageResult>;
  readRunnerProfiles(): ReturnType<PaseoApi["config"]["get"]>;
};

// Lets agent-runner profile helpers reuse `loadPhaseConfig` / `loadStepConfig` with a LoopHost.
export function loopHostConfig(host: LoopHost): Pick<PaseoApi, "config"> {
  return {
    config: {
      get: () => host.readRunnerProfiles(),
      patch: async () => {
        throw new Error("LoopHost does not patch daemon config.");
      },
    },
  };
}

export function paseoLoopHost(paseo: PaseoApi): LoopHost {
  return {
    async listStepAgents() {
      const listed = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200 } });
      return listed.entries.map((entry) => {
        const agent = entry.agent;
        return {
          id: agent.id,
          status: agent.status,
          archivedAt: agent.archivedAt ?? undefined,
          lastError: agent.lastError ?? undefined,
          labels: agent.labels ?? {},
          activeTurn: agent.activeTurn ?? null,
          lastUsage: agent.lastUsage ?? undefined,
        };
      });
    },
    async refreshSession(agentId) {
      try {
        const found = await paseo.agents.ref(agentId).refresh();
        if (!found) return null;
        const agent = found.agent;
        return {
          id: agent.id,
          status: agent.status,
          archivedAt: agent.archivedAt ?? undefined,
          lastError: agent.lastError ?? undefined,
          labels: agent.labels ?? {},
          activeTurn: agent.activeTurn ?? null,
          lastUsage: agent.lastUsage ?? undefined,
        };
      } catch {
        return undefined;
      }
    },
    sendToStep(agentId, text, options) {
      return paseo.agents.ref(agentId).send(text, options).then(() => undefined);
    },
    async timelineTail(agentId, options) {
      try {
        const page = await paseo.agents
          .ref(agentId)
          .timeline.refetch({ direction: "tail", limit: options.limit, projection: "projected" });
        return { entries: page.entries, error: page.error };
      } catch {
        return null;
      }
    },
    async startStepAgent(workspaceId, input) {
      const agent = await paseo.workspaces.ref(workspaceId).agents.create(input);
      return { id: agent.id };
    },
    async refreshStoryWorkspace(workspaceId) {
      try {
        const workspace = await paseo.workspaces.ref(workspaceId).refresh();
        const directory = workspace?.workspaceDirectory ?? "";
        return directory ? { directory } : null;
      } catch {
        return null;
      }
    },
    async createStoryWorkspace(input) {
      const created = await paseo.workspaces.create({
        title: input.title,
        source: {
          kind: "worktree",
          cwd: input.repoRoot,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          action: "branch-off",
          baseBranch: input.baseBranch,
          branchName: input.branchName,
          worktreeSlug: input.worktreeSlug,
        },
      });
      const directory =
        created.directory ?? (await created.refresh())?.workspaceDirectory ?? (await paseo.workspaces.ref(created.id).refresh())?.workspaceDirectory ?? "";
      if (!directory) throw new Error("Paseo created the workspace but did not report its folder.");
      return { id: created.id, directory };
    },
    async listProjects() {
      const { projects } = await paseo.projects.list().catch(() => ({ projects: [] as LoopProject[] }));
      return projects;
    },
    async archiveStoryWorkspace(workspaceId) {
      await paseo.workspaces.archive(workspaceId).catch(() => undefined);
    },
    readPlanUsage() {
      return readPlanUsage(paseo);
    },
    readRunnerProfiles() {
      return paseo.config.get();
    },
  };
}
