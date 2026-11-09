import type { PluginHandlerContext, PluginHookAgent, PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { LoopHost, LoopPermissionRequested, LoopPermissionResolved, LoopProject, LoopTurnEnded } from "../shared/loop-host";
import { readPlanUsage } from "./plan-usage";

type PaseoApi = PluginHandlerContext["paseo"];

// Paseo's hook events as the loop reads them: the agent's id, and how its turn ended.
export function loopTurnEnded(event: { agent: PluginHookAgent; outcome: PluginTurnOutcome; timeline?: readonly unknown[] }): LoopTurnEnded {
  const { outcome } = event;
  return {
    agentId: event.agent.id,
    outcome: outcome.kind === "failed" ? { kind: "failed", message: outcome.error.message } : { kind: outcome.kind },
    timeline: event.timeline,
  };
}

export function loopPermissionRequested(event: { agent: PluginHookAgent; request: { name: string; title?: string } }): LoopPermissionRequested {
  return { agentId: event.agent.id, request: { name: event.request.name, title: event.request.title } };
}

export function loopPermissionResolved(event: { agent: PluginHookAgent }): LoopPermissionResolved {
  return { agentId: event.agent.id };
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
      const directory = created.directory ?? (await created.refresh())?.workspaceDirectory ?? "";
      if (!directory) throw new Error("Paseo created the workspace but did not report its folder.");
      return { id: created.id, directory };
    },
    async listProjects() {
      // A handle with no projects API answers like one that fails: no projects.
      try {
        const { projects } = await paseo.projects.list();
        return projects;
      } catch {
        return [] as LoopProject[];
      }
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
