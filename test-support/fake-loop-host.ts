import type { AgentCreateConfig } from "../shared/agent-runner";
import type { PlanUsageResult } from "../shared/plan-usage";
import type {
  LoopHost,
  LoopSession,
  SendToStepOptions,
  StepAgentCreate,
  StoryWorkspace,
  StoryWorkspaceCreate,
} from "../server/loop-host";

export type FakeAgent = LoopSession & {
  timeline?: unknown[] | "fail";
};

// A fake LoopHost: live agents by id; workspace creates are recorded and become live agents; follow-ups in `sent`.
export function fakeLoopHost(live: FakeAgent[], usage?: { providers: unknown[] | null }) {
  const sent: { id: string; text: string; options?: SendToStepOptions }[] = [];
  const archived: string[] = [];
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
      if (entries === "fail") throw new Error("daemon unreachable");
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
    refreshStoryWorkspace: async () => null,
    createStoryWorkspace: async (input: StoryWorkspaceCreate): Promise<StoryWorkspace> => {
      workspacesCreated += 1;
      const id = `ws${workspacesCreated}`;
      const directory = input.repoRoot;
      return { id, directory };
    },
    listProjects: async () => [],
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

  return { host, created, sent, archived, live };
}
