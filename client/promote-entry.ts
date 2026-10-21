import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";

const PAGE_LIMIT = 200;

type AgentList = Awaited<ReturnType<PluginClientContext["paseo"]["agents"]["list"]>>;
type Agent = AgentList["entries"][number]["agent"];

function openPromote(client: PluginClientContext, params: { workspaceId: string; title?: string }) {
  const trimmed = params.title?.trim();
  client.openScreen({
    screenId: "promote",
    params: {
      workspaceId: params.workspaceId,
      ...(trimmed ? { title: trimmed } : {}),
    },
  });
}

// Both the slash command and the composer pill open the same Promote screen. The slash command
// pre-fills the title from its args; the pill opens an empty form. The pill rides a live agent list
// so it comes and goes with the composer, like the other per-agent pills in this plugin.
export function contributePromoteEntry(client: PluginClientContext) {
  const cleanups: Array<() => void | Promise<void>> = [];

  const offSlash = client.addSlashCommand({
    name: "promote",
    description: "Promote this chat to a story",
    argumentHint: "[title]",
    context: "workspace",
    onSubmit({ args, workspace }) {
      openPromote(client, { workspaceId: workspace.id, title: args });
    },
  });
  cleanups.push(offSlash);

  // Composer pills arrived after this plugin's minimum Paseo version; skip on older apps.
  if (typeof client.addComposerPill !== "function") {
    return async () => {
      await Promise.all(cleanups.map((off) => off()));
    };
  }

  const pills = new Map<string, PluginButtonRegistration>();
  let subscription: AgentList["subscription"] | undefined;
  let stopped = false;

  function register(agent: Agent) {
    if (stopped || !agent.workspaceId || agent.archivedAt) return;
    const workspaceId = agent.workspaceId;
    pills.get(agent.id)?.remove();
    pills.set(
      agent.id,
      client.addComposerPill({
        id: "promote",
        workspaceId,
        agentId: agent.id,
        button: {
          title: "Promote this chat to a story",
          label: "Promote",
          icon: "Rocket",
          behavior: {
            kind: "action",
            onPress: () => openPromote(client, { workspaceId }),
          },
        },
      }),
    );
  }

  function removeAll() {
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  }

  void client.paseo.agents
    .list({ subscribe: {}, filter: { includeArchived: false }, page: { limit: PAGE_LIMIT } })
    .then((list) => {
      if (stopped) {
        void list.subscription.release();
        return;
      }
      subscription = list.subscription;
      for (const { agent } of list.entries) register(agent);
      list.subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAll();
          for (const { agent } of entries) register(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") {
            register(update.agent);
            return;
          }
          const existing = pills.get(update.agentId);
          if (existing) {
            existing.remove();
            pills.delete(update.agentId);
          }
        },
        error: () => {},
      });
    })
    .catch(() => {});

  cleanups.push(() => {
    stopped = true;
    removeAll();
    void subscription?.release();
  });

  return async () => {
    await Promise.all(cleanups.map((off) => off()));
  };
}
