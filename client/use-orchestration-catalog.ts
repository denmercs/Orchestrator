import { useEffect, useState } from "react";
import { usePaseo } from "@getpaseo/plugin/client";

const PAGE_LIMIT = 100;

type PaseoApi = ReturnType<typeof usePaseo>;

function listLiveAgents(paseo: PaseoApi) {
  return paseo.agents.list({
    subscribe: {},
    filter: { includeArchived: false },
    sort: [{ key: "status_priority", direction: "desc" }],
    page: { limit: PAGE_LIMIT },
  });
}

function listLiveWorkspaces(paseo: PaseoApi) {
  return paseo.workspaces.list({
    subscribe: {},
    sort: [{ key: "status_priority", direction: "desc" }],
    page: { limit: PAGE_LIMIT },
  });
}

type AgentList = Awaited<ReturnType<typeof listLiveAgents>>;
type WorkspaceList = Awaited<ReturnType<typeof listLiveWorkspaces>>;

export type OrchestrationAgent = AgentList["entries"][number]["agent"];
export type OrchestrationWorkspace = WorkspaceList["entries"][number];

export function useOrchestrationCatalog() {
  const paseo = usePaseo();
  const [agents, setAgents] = useState<OrchestrationAgent[]>([]);
  const [workspaces, setWorkspaces] = useState<OrchestrationWorkspace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let agentSubscription: AgentList["subscription"] | undefined;
    let workspaceSubscription: WorkspaceList["subscription"] | undefined;

    function applyAgents(entries: AgentList["entries"]) {
      setAgents(
        entries
          .map((entry) => entry.agent)
          .filter((agent) => !isArchivedAgent(agent)),
      );
    }

    function applyWorkspaces(entries: WorkspaceList["entries"]) {
      setWorkspaces(entries.filter((workspace) => !isArchivedWorkspace(workspace)));
    }

    void Promise.all([listLiveAgents(paseo), listLiveWorkspaces(paseo)])
      .then(([agentList, workspaceList]) => {
        if (cancelled) {
          void agentList.subscription.release();
          void workspaceList.subscription.release();
          return;
        }

        agentSubscription = agentList.subscription;
        workspaceSubscription = workspaceList.subscription;
        applyAgents(agentList.entries);
        applyWorkspaces(workspaceList.entries);
        setError(null);
        setLoading(false);

        agentSubscription.subscribe({
          snapshot: ({ entries }) => applyAgents(entries),
          update: (message) => {
            if (message.type !== "agent_update") {
              return;
            }
            const update = message.payload;
            if (update.kind === "remove") {
              setAgents((current) => current.filter((agent) => agent.id !== update.agentId));
              return;
            }
            if (update.kind === "upsert") {
              if (isArchivedAgent(update.agent)) {
                setAgents((current) => current.filter((agent) => agent.id !== update.agent.id));
                return;
              }
              setAgents((current) => upsertById(current, update.agent));
            }
          },
          error: (cause) => {
            setError(cause instanceof Error ? cause.message : "Agent catalog failed");
          },
        });

        workspaceSubscription.subscribe({
          snapshot: ({ entries }) => applyWorkspaces(entries),
          update: (message) => {
            if (message.type !== "workspace_update") {
              return;
            }
            const update = message.payload;
            if (update.kind === "remove") {
              setWorkspaces((current) => current.filter((workspace) => workspace.id !== update.id));
              return;
            }
            if (update.kind === "upsert") {
              if (isArchivedWorkspace(update.workspace)) {
                setWorkspaces((current) =>
                  current.filter((workspace) => workspace.id !== update.workspace.id),
                );
                return;
              }
              setWorkspaces((current) => upsertById(current, update.workspace));
            }
          },
          error: (cause) => {
            setError(cause instanceof Error ? cause.message : "Workspace catalog failed");
          },
        });
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Failed to load orchestration");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      void agentSubscription?.release();
      void workspaceSubscription?.release();
    };
  }, [paseo]);

  return { agents, workspaces, error, loading };
}

function isArchivedAgent(agent: OrchestrationAgent) {
  return Boolean(agent.archivedAt);
}

function isArchivedWorkspace(workspace: OrchestrationWorkspace) {
  return Boolean(workspace.archivingAt);
}

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) {
    return [next, ...items];
  }
  const copy = items.slice();
  copy[index] = next;
  return copy;
}
