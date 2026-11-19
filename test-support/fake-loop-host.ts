import type { AgentCreateConfig } from "../shared/agent-runner";
import type { PlanUsageResult } from "../shared/plan-usage";
import type {
  LoopHost,
  LoopSession,
  SendToStepOptions,
  StepAgentCreate,
  StoryWorkspace,
  StoryWorkspaceAdopt,
  StoryWorkspaceCreate,
  LoopWorkspace,
} from "../shared/loop-host";

export type FakeAgent = LoopSession & {
  timeline?: unknown[] | "fail";
};

// A fake LoopHost: live agents by id; workspace creates are recorded and become live agents; follow-ups in `sent`.
export function fakeLoopHost(live: FakeAgent[], usage?: { providers: unknown[] | null }) {
  const workspaces: LoopWorkspace[] = [];
  const sent: { id: string; text: string; options?: SendToStepOptions }[] = [];
  const archived: string[] = [];
  const adopted: StoryWorkspaceAdopt[] = [];
  const created: {
    workspace: string;
    title: string;
    labels: Record<string, string>;
    config?: AgentCreateConfig;
    prompt?: string;
  }[] = [];
  let workspacesCreated = 0;

  const refresh = async (id: string): Promise<LoopSession | null> => {
    const found = live.find((agent) => agent.id === id);
    return found ? { ...found, labels: { ...found.labels } } : null;
  };

  const host: LoopHost = {
    listStepAgents: async () => live.map((agent) => ({ ...agent, labels: { ...agent.labels } })),
    refreshSession: refresh,
    sendToStep: async (id, text, options) => {
      sent.push(options ? { id, text, options } : { id, text });
    },
    timelineTail: async (id) => {
      const entries = live.find((agent) => agent.id === id)?.timeline ?? [];
      if (entries === "fail") return null;
      return { entries, error: null };
    },
    startStepAgent: async (workspace, input: StepAgentCreate) => {
      const id = `n${created.length + 1}`;
      created.push({
        workspace,
        title: input.title,
        labels: input.labels,
        config: input.config,
        prompt: input.prompt,
      });
      live.push({ id, labels: input.labels });
      return { id };
    },
    refreshStoryWorkspace: async (workspaceId) => {
      const found = workspaces.find((item) => item.id === workspaceId);
      return found?.directory ? { directory: found.directory } : null;
    },
    createStoryWorkspace: async (input: StoryWorkspaceCreate): Promise<StoryWorkspace> => {
      workspacesCreated += 1;
      const id = `ws${workspacesCreated}`;
      const directory = input.repoRoot;
      workspaces.push({ id, directory, projectRootPath: input.repoRoot, busy: false });
      return { id, directory };
    },
    adoptStoryWorkspace: async (input: StoryWorkspaceAdopt): Promise<StoryWorkspace> => {
      adopted.push(input);
      workspacesCreated += 1;
      const id = `ws${workspacesCreated}`;
      const listed = await host.listProjects();
      const projectRoot =
        input.projectId && listed.find((item) => item.projectId === input.projectId)?.projectRootPath
          ? listed.find((item) => item.projectId === input.projectId)!.projectRootPath
          : input.directory;
      workspaces.push({ id, directory: input.directory, projectRootPath: projectRoot, busy: false });
      return { id, directory: input.directory };
    },
    listProjects: async () => [],
    listWorkspaces: async () => workspaces.map((workspace) => ({ ...workspace })),
    archiveStoryWorkspace: async (workspace) => {
      archived.push(workspace);
    },
    readPlanUsage: async (): Promise<PlanUsageResult> => {
      if (!usage) return { providers: null, error: null };
      try {
        if (!usage.providers) throw new Error("daemon down");
        return { providers: usage.providers as PlanUsageResult["providers"], error: null };
      } catch (error) {
        return { providers: null, error: error instanceof Error ? error.message : String(error) };
      }
    },
    readRunnerProfiles: async () => ({ requestId: "fake", config: {} as never }),
  };

  return { host, created, sent, archived, adopted, live, workspaces };
}
