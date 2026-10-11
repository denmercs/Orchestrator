import type { PluginButton, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { contextAct, contextSessionsRpc, type ContextAction, type ContextStatus } from "../shared/context";
import { createContextPillIcon } from "./context-pill-icon";
import { createRequestSequence, createToastQueue, pillMenu, pillView, usageChanged } from "./context-pill-model";
import { RECAP_COMMAND, recapPill } from "./recap-pill-model";

// Paseo stamps spawned sessions with this label; the protocol package does not export it.
const PARENT_LABEL = "paseo.parent-agent-id";
const PAGE_LIMIT = 200;
// Status refetches wait this long so one RPC covers every agent that changed together.
const STATUS_DEBOUNCE_MS = 300;

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

type Pill = { registration: PluginButtonRegistration; workspaceId: string };

// Puts `pillId` on each agent in `buttons` and takes it off every other agent.
function reconcile(
  client: PluginClientContext,
  pillId: string,
  pills: Map<string, Pill>,
  buttons: Map<string, { workspaceId: string; button: PluginButton }>,
) {
  for (const [agentId, { workspaceId, button }] of buttons) {
    const current = pills.get(agentId);
    if (current && current.workspaceId === workspaceId) {
      current.registration.update(button);
      continue;
    }
    current?.registration.remove();
    pills.set(agentId, {
      workspaceId,
      registration: client.addComposerPill({ id: pillId, workspaceId, agentId, button }),
    });
  }
  for (const [agentId, pill] of pills) {
    if (!buttons.has(agentId)) {
      pill.registration.remove();
      pills.delete(agentId);
    }
  }
}

// Three pills share one agent subscription: the role pill (harness/worker), the context pill
// (see CONTEXT.md, "Context pill") and the recap pill.
export function contributeSessionRolePills(client: PluginClientContext) {
  // Composer pills arrived after this plugin's minimum Paseo version; skip on older apps.
  if (typeof client.addComposerPill !== "function") {
    return () => {};
  }
  const openDashboard = () => client.openSurface("orchestration");
  const agents = new Map<string, Agent>();
  const rolePills = new Map<string, Pill>();
  const contextPills = new Map<string, Pill>();
  const recapPills = new Map<string, Pill>();
  const statuses = new Map<string, ContextStatus | null>();
  const toasts = createToastQueue();
  const requests = createRequestSequence();
  const listeners = new Set<() => void>();
  let version = 0;
  const pending = new Set<string>();
  let fetchTimer: ReturnType<typeof setTimeout> | undefined;
  let subscription: AgentList["subscription"] | undefined;
  let stopped = false;

  const contextIcon = createContextPillIcon({
    tone: (agentId) => pillView(statuses.get(agentId) ?? null).tone,
    take: toasts.take,
    version: () => version,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });

  function changed() {
    version += 1;
    for (const listener of listeners) listener();
  }

  function fetchStatus(agentIds: Iterable<string>) {
    for (const agentId of agentIds) pending.add(agentId);
    if (fetchTimer !== undefined || stopped) return;
    fetchTimer = setTimeout(() => {
      fetchTimer = undefined;
      const agentIds = [...pending];
      pending.clear();
      if (!agentIds.length) return;
      const request = requests.start(agentIds);
      void client
        .rpc(contextSessionsRpc, { agentIds })
        .then((results) => {
          if (stopped) return;
          const fresh = agentIds.flatMap((agentId, index) =>
            requests.isLatest(agentId, request) ? [{ agentId, status: results[index] ?? null }] : [],
          );
          for (const { agentId, status } of fresh) statuses.set(agentId, status);
          toasts.load(fresh.map(({ status }) => status));
          sync();
          changed();
        })
        .catch(() => {});
    }, STATUS_DEBOUNCE_MS);
  }

  function act(agentId: string, action: ContextAction) {
    void client
      .rpc(contextAct, { agentId, action })
      .then((result) => {
        if (!result.ok) toasts.fail(agentId, result.error ?? "That context action failed.");
      })
      .catch((cause: unknown) => {
        toasts.fail(agentId, cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        changed();
        fetchStatus([agentId]);
      });
  }

  function contextButton(agent: Agent): PluginButton {
    const status = statuses.get(agent.id) ?? null;
    const view = pillView(status);
    return {
      title: view.title,
      label: view.label,
      icon: contextIcon,
      behavior: {
        kind: "menu",
        items: pillMenu(status, agent.status === "running").map((item) => ({
          kind: "item" as const,
          id: item.action,
          title: item.title,
          disabled: item.disabled,
          behavior: { kind: "action" as const, onPress: () => act(agent.id, item.action) },
        })),
      },
    };
  }

  function recap(agentId: string) {
    void client.paseo.agents
      .ref(agentId)
      .send(RECAP_COMMAND)
      .catch((cause: unknown) => {
        toasts.fail(agentId, cause instanceof Error ? cause.message : String(cause));
        changed();
      });
  }

  function recapButton(agent: Agent): PluginButton | null {
    const view = recapPill(agent);
    if (!view) return null;
    return { ...view, icon: "History", behavior: { kind: "action", onPress: () => recap(agent.id) } };
  }

  function sync() {
    const live = [...agents.values()].filter(isLive);
    const childCounts = new Map<string, number>();
    for (const agent of live) {
      const parentId = parentOf(agent);
      if (parentId) {
        childCounts.set(parentId, (childCounts.get(parentId) ?? 0) + 1);
      }
    }

    const roleButtons = new Map<string, { workspaceId: string; button: PluginButton }>();
    const contextButtons = new Map<string, { workspaceId: string; button: PluginButton }>();
    const recapButtons = new Map<string, { workspaceId: string; button: PluginButton }>();
    for (const agent of live) {
      if (!agent.workspaceId) {
        continue;
      }
      const button = pillFor(agent, agents, childCounts.get(agent.id) ?? 0, openDashboard);
      if (button) {
        roleButtons.set(agent.id, { workspaceId: agent.workspaceId, button });
      }
      contextButtons.set(agent.id, { workspaceId: agent.workspaceId, button: contextButton(agent) });
      const recapPillButton = recapButton(agent);
      if (recapPillButton) {
        recapButtons.set(agent.id, { workspaceId: agent.workspaceId, button: recapPillButton });
      }
    }
    reconcile(client, "session-role", rolePills, roleButtons);
    reconcile(client, "session-context", contextPills, contextButtons);
    reconcile(client, "session-recap", recapPills, recapButtons);
  }

  function replace(entries: AgentList["entries"]) {
    agents.clear();
    for (const entry of entries) {
      agents.set(entry.agent.id, entry.agent);
    }
    sync();
    fetchStatus(contextPills.keys());
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
            statuses.delete(update.agentId);
          } else if (update.kind === "upsert") {
            if (update.agent.workspaceId && usageChanged(agents.get(update.agent.id), update.agent)) {
              fetchStatus([update.agent.id]);
            }
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
    clearTimeout(fetchTimer);
    void subscription?.release();
    for (const pill of [...rolePills.values(), ...contextPills.values(), ...recapPills.values()]) {
      pill.registration.remove();
    }
    rolePills.clear();
    contextPills.clear();
    recapPills.clear();
    listeners.clear();
  };
}
