import type { OrchestrationAgent, OrchestrationWorkspace } from "./use-orchestration-catalog";

export type PhaseId = "todo" | "planning" | "awaiting-approval" | "implementing" | "review";

export type BoardItem = {
  id: string;
  key: string;
  title: string;
  detail: string;
  underTitle: string | null;
  phaseId: PhaseId;
  phaseLabel: string;
  pr: string | null;
  retryLabel: string | null;
  progress: number | null;
  agentId: string | null;
  workspaceId: string | null;
  isMainSession: boolean;
  role: "story" | "epic" | "child";
};

export type BoardFamily = {
  epic: BoardItem;
  children: BoardItem[];
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
  families: BoardFamily[];
  stories: BoardItem[];
  phases: { id: PhaseId; label: string; hint: string; items: BoardItem[] }[];
  merged: BoardItem[];
  blocked: BoardItem[];
};

export type ScheduleRow = {
  status: "active" | "paused" | "completed";
  name: string | null;
};

export type ParentLink = {
  agentId: string;
  parentAgentId: string | null;
};

const PHASES: { id: PhaseId; label: string; hint: string }[] = [
  { id: "todo", label: "Idle", hint: "Not running yet" },
  { id: "planning", label: "Starting", hint: "Agent is initializing" },
  { id: "awaiting-approval", label: "Needs approval", hint: "Waiting on a permission" },
  { id: "implementing", label: "Running", hint: "Working now" },
  { id: "review", label: "Needs you", hint: "Finished, error, or attention" },
];

export function createBoardModel(
  agents: OrchestrationAgent[],
  workspaces: OrchestrationWorkspace[],
  schedules: ScheduleRow[],
  parentLinks: ParentLink[] = [],
  now = new Date(),
): BoardModel {
  const byPhase: Record<PhaseId, BoardItem[]> = {
    todo: [],
    planning: [],
    "awaiting-approval": [],
    implementing: [],
    review: [],
  };

  const waitingOnYou: BoardItem[] = [];
  const merged: BoardItem[] = [];
  const blocked: BoardItem[] = [];
  const activeAgents = agents.filter((agent) => !agent.archivedAt && agent.status !== "closed");
  const parentById = parentMap(activeAgents, parentLinks);
  const items = activeAgents.map((agent) => toAgentItem(agent, workspaces, parentById));
  const itemsById = new Map(items.map((item) => [item.id, item]));

  for (const item of items) {
    const parentId = parentById.get(item.id);
    if (item.role === "child" && parentId) {
      const parent = itemsById.get(parentId);
      item.underTitle = parent ? parent.title : "archived epic";
    }
    byPhase[item.phaseId].push(item);
  }

  for (const agent of activeAgents) {
    const item = itemsById.get(agent.id);
    if (item && isBlocked(agent)) {
      blocked.push(item);
      waitingOnYou.push(item);
    }
  }

  const uniqueMerged = uniqueById(merged);
  const ready = byPhase.todo;
  const next = ready[0] ?? waitingOnYou[0];
  const loopRunning = schedules.some((schedule) => schedule.status === "active");

  return {
    title: "Sessions",
    loopStatus: loopRunning ? "running" : "stopped",
    nextLabel: next ? `${next.key} ${next.title}` : "nothing ready",
    blockedSummary: blocked.length
      ? blocked.map((item) => item.key).join("; ") + " blocked"
      : "nothing blocked",
    updatedAt: now.toLocaleTimeString(),
    total: activeAgents.length,
    mergedCount: uniqueMerged.length,
    inProgress: byPhase.implementing.length,
    readyToStart: ready.length,
    waitingOnDependencies: byPhase.planning.length,
    blockedCount: blocked.length,
    waitingOnYou,
    families: buildFamilies(items, parentById),
    stories: items.filter((item) => item.role === "story"),
    phases: PHASES.map((phase) => ({ ...phase, items: byPhase[phase.id] })),
    merged: uniqueMerged,
    blocked,
  };
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

function parentMap(agents: OrchestrationAgent[], links: ParentLink[]) {
  const byId = new Map<string, string | null>();
  for (const agent of agents) {
    byId.set(agent.id, snapshotParentId(agent));
  }
  for (const link of links) {
    byId.set(link.agentId, link.parentAgentId);
  }
  return byId;
}

function snapshotParentId(agent: OrchestrationAgent) {
  const extra = agent as OrchestrationAgent & { parentAgentId?: string | null };
  return typeof extra.parentAgentId === "string" && extra.parentAgentId.length > 0
    ? extra.parentAgentId
    : null;
}

function sessionRole(
  agent: OrchestrationAgent,
  parentById: Map<string, string | null>,
): BoardItem["role"] {
  if (parentById.get(agent.id)) {
    return "child";
  }
  const spawned = [...parentById.values()].some((parentId) => parentId === agent.id);
  return spawned ? "epic" : "story";
}

function toAgentItem(
  agent: OrchestrationAgent,
  workspaces: OrchestrationWorkspace[],
  parentById: Map<string, string | null>,
): BoardItem {
  const role = sessionRole(agent, parentById);
  const phaseId = phaseForAgent(agent);
  const { key, title } = splitKey(agent.title ?? agent.id);
  const workspaceName = workspaces.find((workspace) => workspace.id === agent.workspaceId)?.name;
  return {
    id: agent.id,
    key,
    title,
    detail: [agentDetail(agent), workspaceName].filter(Boolean).join(" · "),
    underTitle: null,
    phaseId,
    phaseLabel: PHASES.find((phase) => phase.id === phaseId)?.label ?? phaseId,
    pr: null,
    retryLabel: role === "child" ? null : sessionActionLabel(agent),
    progress: null,
    agentId: agent.id,
    workspaceId: agent.workspaceId ?? null,
    isMainSession: role !== "child",
    role,
  };
}

function buildFamilies(
  items: BoardItem[],
  parentById: Map<string, string | null>,
): BoardFamily[] {
  const epics = items.filter((item) => item.role === "epic");
  const children = items.filter((item) => item.role === "child");
  const families = epics.map((epic) => ({
    epic,
    children: children.filter((child) => parentById.get(child.id) === epic.id),
  }));
  const attached = new Set(families.flatMap((family) => family.children.map((child) => child.id)));
  const orphans = children.filter((child) => !attached.has(child.id));
  const orphanGroups = new Map<string, BoardItem[]>();
  for (const child of orphans) {
    const parentId = parentById.get(child.id) ?? "unknown";
    const group = orphanGroups.get(parentId) ?? [];
    group.push(child);
    orphanGroups.set(parentId, group);
  }
  for (const [parentId, group] of orphanGroups) {
    families.push({
      epic: {
        id: parentId,
        key: "",
        title: group[0]?.underTitle ?? "Epic",
        detail: "parent session not on the board",
        underTitle: null,
        phaseId: "todo",
        phaseLabel: "Idle",
        pr: null,
        retryLabel: null,
        progress: null,
        agentId: parentId === "unknown" ? null : parentId,
        workspaceId: null,
        isMainSession: true,
        role: "epic",
      },
      children: group,
    });
  }
  return families;
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

function sessionActionLabel(agent: OrchestrationAgent) {
  if (hasPendingPermission(agent)) {
    return "Retry → review";
  }
  if (agent.status === "error") {
    return "Retry → implementing";
  }
  return "Open session";
}

function splitKey(label: string) {
  const match = label.match(/^([A-Z][A-Z0-9]+-\d+)\s+[—–-]\s+(.+)$/);
  if (match) {
    return { key: match[1], title: match[2] };
  }
  const ticket = label.match(/^([A-Z][A-Z0-9]+-\d+)\b/);
  if (ticket) {
    return { key: ticket[1], title: label };
  }
  return { key: "", title: label };
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
