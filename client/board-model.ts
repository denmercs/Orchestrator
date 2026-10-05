import type { JiraIssue } from "../shared/orchestration";
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
  url: string | null;
  source: "session" | "jira" | "both";
  parentKey: string | null;
  completed: boolean;
  startLabel: string | null;
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
  hasJira: boolean;
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
  jiraIssues: JiraIssue[] = [],
  jiraBoardName: string | null = null,
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
  const sessionParents = parentMap(activeAgents, parentLinks);
  const sessionItems = activeAgents.map((agent) => toAgentItem(agent, workspaces, sessionParents));
  const items = mergeJiraItems(sessionItems, jiraIssues);
  const parentById = familyParentMap(items, sessionParents);
  const itemsById = new Map(items.map((item) => [item.id, item]));

  for (const item of items) {
    const parentId = parentById.get(item.id);
    if (item.role === "child" && parentId) {
      const parent = itemsById.get(parentId);
      item.underTitle = parent ? parentTitle(parent) : item.underTitle ?? "archived epic";
    }
    if (isMergedItem(item)) {
      merged.push(item);
      continue;
    }
    byPhase[item.phaseId].push(item);
  }

  for (const item of items) {
    if (isBlockedItem(item, activeAgents)) {
      blocked.push(item);
      waitingOnYou.push(item);
    }
  }

  const uniqueMerged = uniqueById(merged);
  const ready = byPhase.todo;
  const next = byPhase.implementing[0] ?? ready[0] ?? waitingOnYou[0];
  const loopRunning = schedules.some((schedule) => schedule.status === "active");
  const liveItems = items.filter((item) => !isMergedItem(item));

  return {
    title: jiraIssues.length > 0 ? (jiraBoardName ?? "Jira") : "Sessions",
    loopStatus: loopRunning ? "running" : "stopped",
    nextLabel: next ? `${next.key} ${next.title}`.trim() : "nothing ready",
    blockedSummary: blocked.length
      ? blocked.map((item) => item.key || item.title).join("; ") + " blocked"
      : "nothing blocked",
    updatedAt: now.toLocaleTimeString(),
    total: liveItems.length,
    mergedCount: uniqueMerged.length,
    inProgress: byPhase.implementing.length,
    readyToStart: ready.length,
    waitingOnDependencies: byPhase.planning.length,
    blockedCount: blocked.length,
    waitingOnYou,
    families: buildFamilies(liveItems, parentById),
    stories: liveItems.filter((item) => item.role === "story"),
    phases: PHASES.map((phase) => ({ ...phase, items: byPhase[phase.id] })),
    merged: uniqueMerged,
    blocked,
    hasJira: jiraIssues.length > 0,
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
    url: null,
    source: "session",
    parentKey: null,
    completed: false,
    startLabel: null,
  };
}

function mergeJiraItems(sessionItems: BoardItem[], jiraIssues: JiraIssue[]): BoardItem[] {
  if (jiraIssues.length === 0) {
    return sessionItems;
  }

  const byKey = new Map<string, BoardItem>();
  const unmatched: BoardItem[] = [];
  for (const item of sessionItems) {
    if (item.key) {
      byKey.set(item.key, item);
    } else {
      unmatched.push(item);
    }
  }

  for (const issue of jiraIssues) {
    const current = byKey.get(issue.key);
    byKey.set(issue.key, current ? overlayJira(current, issue) : toJiraItem(issue));
  }

  return [...unmatched, ...byKey.values()];
}

function overlayJira(item: BoardItem, issue: JiraIssue): BoardItem {
  const done = isJiraDone(issue);
  const keepSessionPhase =
    item.agentId != null &&
    (item.phaseId === "implementing" ||
      item.phaseId === "awaiting-approval" ||
      item.phaseId === "review");
  const phaseId = keepSessionPhase || done ? item.phaseId : phaseForJira(issue);
  return {
    ...item,
    title: issue.summary || item.title,
    detail: [issue.status, item.detail].filter(Boolean).join(" · "),
    underTitle: issue.parentSummary ?? item.underTitle,
    phaseId,
    phaseLabel: done && !keepSessionPhase
      ? issue.status
      : (PHASES.find((phase) => phase.id === phaseId)?.label ?? phaseId),
    retryLabel: item.retryLabel ?? (item.agentId ? "Open session" : null),
    role: jiraRole(issue, item.role),
    url: issue.url,
    source: item.source === "session" ? "both" : item.source,
    parentKey: issue.parentKey ?? item.parentKey,
    completed: done && !keepSessionPhase,
    startLabel: done && !keepSessionPhase ? null : startLabelForRole(jiraRole(issue, item.role)),
  };
}

function toJiraItem(issue: JiraIssue): BoardItem {
  const merged = isJiraDone(issue);
  const phaseId = phaseForJira(issue);
  const role = jiraRole(issue, "story");
  return {
    id: `jira:${issue.key}`,
    key: issue.key,
    title: issue.summary,
    detail: [issue.status, issue.assignee].filter(Boolean).join(" · "),
    underTitle: issue.parentSummary,
    phaseId,
    phaseLabel: merged ? issue.status : (PHASES.find((phase) => phase.id === phaseId)?.label ?? issue.status),
    pr: null,
    retryLabel: null,
    progress: null,
    agentId: null,
    workspaceId: null,
    isMainSession: role !== "child",
    role,
    url: issue.url,
    source: "jira",
    parentKey: issue.parentKey,
    completed: merged,
    startLabel: merged ? null : startLabelForRole(role),
  };
}

function startLabelForRole(role: BoardItem["role"]) {
  return role === "epic" ? "Start epic loop" : "Start session";
}

function jiraRole(issue: JiraIssue, fallback: BoardItem["role"]): BoardItem["role"] {
  if (issue.issueType.toLowerCase() === "epic") {
    return "epic";
  }
  if (issue.parentKey || issue.issueType.toLowerCase() === "sub-task") {
    return "child";
  }
  return fallback === "epic" ? "story" : fallback;
}

function phaseForJira(issue: JiraIssue): PhaseId {
  if (isJiraDone(issue)) {
    return "review";
  }
  const status = issue.status.toLowerCase();
  const category = issue.statusCategory.toLowerCase();
  if (status.includes("block")) {
    return "review";
  }
  if (status === "selected for development") {
    return "planning";
  }
  if (category === "indeterminate" || status === "in progress") {
    return "implementing";
  }
  return "todo";
}

function isJiraDone(issue: JiraIssue) {
  return (
    issue.statusCategory.toLowerCase() === "done" || issue.status.toLowerCase() === "done"
  );
}

function isMergedItem(item: BoardItem) {
  return item.completed;
}

function isBlockedItem(item: BoardItem, agents: OrchestrationAgent[]) {
  if (/\bblock/.test(`${item.detail} ${item.phaseLabel}`.toLowerCase())) {
    return true;
  }
  const agent = agents.find((entry) => entry.id === item.agentId);
  return agent ? isBlocked(agent) : false;
}

function familyParentMap(
  items: BoardItem[],
  sessionParents: Map<string, string | null>,
) {
  const idByKey = new Map<string, string>();
  for (const item of items) {
    if (item.key) {
      idByKey.set(item.key, item.id);
    }
  }
  const parents = new Map<string, string | null>();
  for (const item of items) {
    if (item.parentKey && idByKey.has(item.parentKey)) {
      parents.set(item.id, idByKey.get(item.parentKey) ?? null);
      continue;
    }
    parents.set(item.id, sessionParents.get(item.id) ?? null);
  }
  return parents;
}

function parentTitle(parent: BoardItem) {
  return parent.key ? `${parent.key} ${parent.title}` : parent.title;
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
        url: null,
        source: "session",
        parentKey: null,
        completed: false,
        startLabel: null,
      },
      children: group,
    });
  }
  return families.filter(
    (family) => family.children.length > 0 || family.epic.phaseId !== "todo",
  );
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
