import type { AgentCreateConfig } from "./agent-runner";
import type { PlanUsageResult } from "./plan-usage";

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

// A workspace as the host lists it. `busy` means an agent in it is running or initializing.
export type LoopWorkspace = {
  id: string;
  directory: string;
  projectRootPath: string;
  busy: boolean;
};

export type SendToStepOptions = {
  activeTurnBehavior?: "steer" | "interrupt";
};

// Host port for the initiative loop: agent and workspace actions the loop drives, not Paseo types.
export type LoopHost = {
  listStepAgents(): Promise<LoopSession[]>;
  // null when the session is gone; undefined when the host could not answer (try again later).
  // One null is not proof: the loop reads again and checks the agent list before it counts a session as gone.
  refreshSession(agentId: string): Promise<LoopSession | null | undefined>;
  sendToStep(agentId: string, text: string, options?: SendToStepOptions): Promise<void>;
  // null when the timeline could not be read.
  timelineTail(
    agentId: string,
    options: { limit: number },
  ): Promise<{ entries: unknown[]; error: string | null } | null>;
  startStepAgent(workspaceId: string, input: StepAgentCreate): Promise<{ id: string }>;
  refreshStoryWorkspace(workspaceId: string): Promise<{ directory: string } | null>;
  createStoryWorkspace(input: StoryWorkspaceCreate): Promise<StoryWorkspace>;
  // Never rejects: a host with no project list answers [].
  listProjects(): Promise<LoopProject[]>;
  // Never rejects: a host that cannot list answers [].
  listWorkspaces(): Promise<LoopWorkspace[]>;
  archiveStoryWorkspace(workspaceId: string): Promise<void>;
  readPlanUsage(): Promise<PlanUsageResult>;
  // The host's agent profiles as the daemon reports them (the raw `config.get` result); `profilesFromConfigGet` reads it.
  readRunnerProfiles(): Promise<unknown>;
};

// A turn that ended, as the loop reads it: which agent, how it ended, and what it did (the timeline's entries, when the host has them).
export type LoopTurnOutcome = { kind: "completed" } | { kind: "failed"; message: string } | { kind: "canceled" };

export type LoopTurnEnded = {
  agentId: string;
  outcome: LoopTurnOutcome;
  timeline?: readonly unknown[];
};

export type LoopPermissionRequested = {
  agentId: string;
  request: { name: string; title?: string };
};

export type LoopPermissionResolved = {
  agentId: string;
};
