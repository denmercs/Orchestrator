import { useEffect, useState } from "react";
import type {
  OwnedSubscription,
  PaseoAgent,
  PaseoAgentListResult,
  PaseoWorkspace,
  PaseoWorkspaceListResult,
} from "@getpaseo/client";
import { usePaseo } from "@getpaseo/plugin/client";

const PAGE_LIMIT = 100;

export type OrchestrationAgent = PaseoAgent;
export type OrchestrationWorkspace = PaseoWorkspace;

export function useOrchestrationCatalog() {
  const paseo = usePaseo();
  const [agents, setAgents] = useState<OrchestrationAgent[]>([]);
  const [workspaces, setWorkspaces] = useState<OrchestrationWorkspace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let agentSubscription: OwnedSubscription<PaseoAgentListResult> | undefined;
    let workspaceSubscription: OwnedSubscription<PaseoWorkspaceListResult> | undefined;

    function applyAgents(entries: PaseoAgentListResult["entries"]) {
      setAgents(
        entries
          .map((entry) => entry.agent)
          .filter((agent) => !agent.archivedAt),
      );
    }

    function applyWorkspaces(entries: PaseoWorkspaceListResult["entries"]) {
      setWorkspaces(entries.filter((workspace) => !workspace.archivingAt));
    }

    void Promise.all([
      paseo.agents.list({
        subscribe: {},
        filter: { includeArchived: false },
        sort: [{ key: "status_priority", direction: "desc" }],
        page: { limit: PAGE_LIMIT },
      }),
      paseo.workspaces.list({
        subscribe: {},
        sort: [{ key: "status_priority", direction: "desc" }],
        page: { limit: PAGE_LIMIT },
      }),
    ])
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
            if (update.kind === "upsert" && !update.agent.archivedAt) {
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
            if (update.kind === "upsert" && !update.workspace.archivingAt) {
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

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) {
    return [next, ...items];
  }
  const copy = items.slice();
  copy[index] = next;
  return copy;
}
