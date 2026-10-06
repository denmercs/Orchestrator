import type { PluginButton, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";

// Paseo stamps spawned sessions with this label; the protocol package does not export it.
const PARENT_LABEL = "paseo.parent-agent-id";
const PAGE_LIMIT = 200;

type AgentList = Awaited<ReturnType<typeof listAgents>>;
type Agent = AgentList["entries"][number]["agent"];

function listAgents(client: PluginClientContext) {
  return client.paseo.agents.list({
    subscribe: {},
    filter: { includeArchived: false },
    page: { limit: PAGE_LIMIT },
  });
}

function parentOf(agent: Agent) {
  const fromLabel = agent.labels?.[PARENT_LABEL]?.trim();
  const extra = agent as Agent & { parentAgentId?: string | null };
  return fromLabel || extra.parentAgentId || null;
}

function isLive(agent: Agent) {
  return !agent.archivedAt && agent.status !== "closed";
}

// A session that spawned others (or an epic loop) is the harness; a session it spawned is a worker.
function pillFor(
  agent: Agent,
  agents: Map<string, Agent>,
  childCount: number,
  openDashboard: () => void,
): PluginButton | null {
  const parentId = parentOf(agent);
  if (parentId) {
    const parent = agents.get(parentId);
    const parentName = parent?.title ?? "parent session";
    return {
      title: `Worker under ${parentName}`,
      label: "Worker",
      icon: "GitBranch",
      behavior: { kind: "action", onPress: openDashboard },
    };
  }
  // A single standalone run gets no tag, so a tag always means a harness/worker pair.
  if (childCount === 0 && agent.labels?.kind !== "epic-loop") {
    return null;
  }
  return {
    title:
      childCount > 0
        ? `Harness running ${childCount} ${childCount === 1 ? "worker" : "workers"}`
        : "Harness · no workers yet",
    label: childCount > 0 ? `Harness · ${childCount}` : "Harness",
    icon: "Network",
    behavior: { kind: "action", onPress: openDashboard },
  };
}

export function contributeSessionRolePills(client: PluginClientContext) {
  // Composer pills arrived after this plugin's minimum Paseo version; skip on older apps.
  if (typeof client.addComposerPill !== "function") {
    return () => {};
  }
  const openDashboard = () => client.openSurface("orchestration");
  const agents = new Map<string, Agent>();
  const pills = new Map<string, { registration: PluginButtonRegistration; workspaceId: string }>();
  let subscription: AgentList["subscription"] | undefined;
  let stopped = false;

  function sync() {
    const live = [...agents.values()].filter(isLive);
    const childCounts = new Map<string, number>();
    for (const agent of live) {
      const parentId = parentOf(agent);
      if (parentId) {
        childCounts.set(parentId, (childCounts.get(parentId) ?? 0) + 1);
      }
    }

    const wanted = new Set<string>();
    for (const agent of live) {
      const button = agent.workspaceId
        ? pillFor(agent, agents, childCounts.get(agent.id) ?? 0, openDashboard)
        : null;
      if (!button || !agent.workspaceId) {
        continue;
      }
      wanted.add(agent.id);
      const current = pills.get(agent.id);
      if (current && current.workspaceId === agent.workspaceId) {
        current.registration.update(button);
        continue;
      }
      current?.registration.remove();
      pills.set(agent.id, {
        workspaceId: agent.workspaceId,
        registration: client.addComposerPill({
          id: "session-role",
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          button,
        }),
      });
    }

    for (const [agentId, pill] of pills) {
      if (!wanted.has(agentId)) {
        pill.registration.remove();
        pills.delete(agentId);
      }
    }
  }

  function replace(entries: AgentList["entries"]) {
    agents.clear();
    for (const entry of entries) {
      agents.set(entry.agent.id, entry.agent);
    }
    sync();
  }

  void listAgents(client)
    .then((list) => {
      if (stopped) {
        void list.subscription.release();
        return;
      }
      subscription = list.subscription;
      replace(list.entries);
      subscription.subscribe({
        snapshot: ({ entries }) => replace(entries),
        update: (message) => {
          if (message.type !== "agent_update") {
            return;
          }
          const update = message.payload;
          if (update.kind === "remove") {
            agents.delete(update.agentId);
          } else if (update.kind === "upsert") {
            agents.set(update.agent.id, update.agent);
          }
          sync();
        },
        error: () => {},
      });
    })
    .catch(() => {});

  return () => {
    stopped = true;
    void subscription?.release();
    for (const pill of pills.values()) {
      pill.registration.remove();
    }
    pills.clear();
  };
}
