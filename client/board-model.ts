import type { OrchestrationAgent, OrchestrationWorkspace } from "./use-orchestration-catalog";

export type PhaseId =
  | "todo"
  | "planning"
  | "awaiting-approval"
  | "implementing"
  | "review"
  | "pr-open";

export type BoardItem = {
  id: string;
  key: string;
  title: string;
  detail: string;
  pr: string | null;
  retryLabel: string | null;
  progress: number | null;
  agentId: string | null;
  workspaceId: string | null;
};

export type BoardModel = {
  title: string;
  loopStatus: "running" | "stopped";
  nextLabel: string;
  blockedSummary: string;
  updatedAt: string;
  total: number;
  mergedCount: number;
  inProgress: number;
  readyToStart: number;
  waitingOnDependencies: number;
  blockedCount: number;
  waitingOnYou: BoardItem[];
  phases: { id: PhaseId; label: string; count: number }[];
  merged: BoardItem[];
  blocked: BoardItem[];
};

export type ScheduleRow = {
  status: "active" | "paused" | "completed";
  name: string | null;
};

const PHASES: { id: PhaseId; label: string }[] = [
  { id: "todo", label: "todo" },
  { id: "planning", label: "planning" },
  { id: "awaiting-approval", label: "Awaiting approval" },
  { id: "implementing", label: "Implementing" },
  { id: "review", label: "Review" },
  { id: "pr-open", label: "PR open" },
];

export function createBoardModel(
  agents: OrchestrationAgent[],
  workspaces: OrchestrationWorkspace[],
  schedules: ScheduleRow[],
  now = new Date(),
): BoardModel {
  const byPhase: Record<PhaseId, BoardItem[]> = {
    todo: [],
    planning: [],
    "awaiting-approval": [],
    implementing: [],
    review: [],
    "pr-open": [],
  };

  const waitingOnYou: BoardItem[] = [];
  const merged: BoardItem[] = [];
  const blocked: BoardItem[] = [];

  for (const agent of agents) {
    const item = toAgentItem(agent);
    const phase = phaseForAgent(agent);
    byPhase[phase].push(item);

    if (agent.status === "closed") {
      merged.push(item);
      continue;
    }
    if (isBlocked(agent)) {
      blocked.push(item);
      waitingOnYou.push(item);
    }
  }

  for (const workspace of workspaces) {
    if (workspace.status === "done") {
      merged.push(toWorkspaceItem(workspace));
    }
  }

  const uniqueMerged = uniqueById(merged);
  const ready = byPhase.todo;
  const next = ready[0] ?? waitingOnYou[0];
  const loopRunning = schedules.some((schedule) => schedule.status === "active");

  return {
    title: boardTitle(workspaces, agents),
    loopStatus: loopRunning ? "running" : "stopped",
    nextLabel: next ? `${next.key} ${next.title}` : "nothing ready",
    blockedSummary: blocked.length
      ? blocked.map((item) => item.key).join("; ") + " blocked"
      : "nothing blocked",
    updatedAt: now.toLocaleTimeString(),
    total: Math.max(agents.length, uniqueMerged.length + blocked.length + ready.length),
    mergedCount: uniqueMerged.length,
    inProgress: byPhase.implementing.length,
    readyToStart: ready.length,
    waitingOnDependencies: byPhase.planning.length,
    blockedCount: blocked.length,
    waitingOnYou,
    phases: PHASES.map((phase) => ({ ...phase, count: byPhase[phase.id].length })),
    merged: uniqueMerged,
    blocked,
  };
}

function boardTitle(workspaces: OrchestrationWorkspace[], agents: OrchestrationAgent[]) {
  const named = workspaces.find((workspace) => workspace.name);
  if (named?.name) {
    return named.name;
  }
  const titled = agents.find((agent) => agent.title);
  return titled?.title ?? "Orchestration";
}

function phaseForAgent(agent: OrchestrationAgent): PhaseId {
  if (hasPendingPermission(agent)) {
    return "awaiting-approval";
  }
  if (agent.status === "running") {
    return "implementing";
  }
  if (agent.status === "initializing") {
    return "planning";
  }
  if (agent.status === "error" || agent.attentionReason === "error") {
    return "review";
  }
  if (agent.status === "closed") {
    return "pr-open";
  }
  if (agent.requiresAttention || agent.attentionReason === "finished") {
    return "review";
  }
  return "todo";
}

function isBlocked(agent: OrchestrationAgent) {
  return (
    agent.status === "error" ||
    hasPendingPermission(agent) ||
    Boolean(agent.requiresAttention) ||
    agent.attentionReason === "error"
  );
}

function hasPendingPermission(agent: OrchestrationAgent) {
  return (agent.pendingPermissions?.length ?? 0) > 0 || agent.attentionReason === "permission";
}

function toAgentItem(agent: OrchestrationAgent): BoardItem {
  const { key, title } = splitKey(agent.title ?? shortId(agent.id));
  return {
    id: agent.id,
    key,
    title,
    detail: agentDetail(agent),
    pr: null,
    retryLabel: retryLabel(agent),
    progress: agent.status === "error" ? 0.35 : agent.status === "running" ? 0.6 : null,
    agentId: agent.id,
    workspaceId: agent.workspaceId ?? null,
  };
}

function toWorkspaceItem(workspace: OrchestrationWorkspace): BoardItem {
  const { key, title } = splitKey(workspace.name);
  return {
    id: workspace.id,
    key,
    title,
    detail: workspace.projectDisplayName,
    pr: null,
    retryLabel: null,
    progress: 1,
    agentId: null,
    workspaceId: workspace.id,
  };
}

function agentDetail(agent: OrchestrationAgent) {
  if (agent.lastError) {
    return agent.lastError;
  }
  if (hasPendingPermission(agent)) {
    return "needs permission";
  }
  if (agent.requiresAttention) {
    return agent.attentionReason ?? "needs attention";
  }
  return [agent.provider, agent.model].filter(Boolean).join(" · ");
}

function retryLabel(agent: OrchestrationAgent) {
  if (hasPendingPermission(agent)) {
    return "Retry → review";
  }
  if (agent.status === "error") {
    return "Retry → implementing";
  }
  if (agent.requiresAttention) {
    return "Open session";
  }
  return "Open session";
}

function splitKey(label: string) {
  const match = label.match(/^([A-Z][A-Z0-9]+-\S+)\s+[—–-]\s+(.+)$/);
  if (match) {
    return { key: match[1], title: match[2] };
  }
  return { key: shortId(label), title: label };
}

function uniqueById(items: BoardItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });
}

function shortId(value: string) {
  return value.slice(0, 8);
}
