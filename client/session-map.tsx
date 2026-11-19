import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { LOOP_AGENT_KIND } from "../shared/initiative-loop";
import { providerLabel, providerNote, sessionMap, type MapNode, type NodeState } from "./session-map-model";
import { storySessions } from "./session-log-model";

// Who is working on one story right now: the main session, the subagents it delegated to, and the
// reviewer on call, each with its provider and model. A read-only view; it starts and stops nothing.

type Theme = PluginSurfaceProps["theme"];
type PaseoApi = ReturnType<typeof usePaseo>;
type Agent = Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"][number]["agent"];

const POLL_MS = 3000;
const PAGE_LIMIT = 200;

export function SessionMap({
  storyId,
  initiative,
  workspace,
  theme,
}: {
  storyId: string;
  initiative: string;
  workspace: string;
  theme: Theme;
}) {
  const paseo = usePaseo();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [agents, setAgents] = useState<{ loop: Agent[]; all: Agent[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [loop, all] = await Promise.all([
          paseo.agents.list({
            filter: { labels: { kind: LOOP_AGENT_KIND, "loop-initiative": initiative, "loop-story": storyId }, includeArchived: true },
            sort: [{ key: "created_at", direction: "asc" }],
            page: { limit: 50 },
          }),
          paseo.agents.list({ filter: { includeArchived: false }, page: { limit: PAGE_LIMIT } }),
        ]);
        if (cancelled) return;
        setAgents({
          loop: storySessions(loop.entries.map((entry) => entry.agent), workspace),
          all: all.entries.map((entry) => entry.agent),
        });
      } catch {
        // The session log below reports list errors; the map just stays as it was.
      }
    }
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [paseo, storyId, initiative, workspace]);

  const map = useMemo(() => (agents ? sessionMap(agents.loop, agents.all) : null), [agents]);
  if (!map?.main) return null;
  const note = providerNote(map);

  return (
    <View style={styles.wrap}>
      <Text style={styles.sectionLabel}>SESSION MAP</Text>
      <NodeRow node={map.main} styles={styles} theme={theme} />
      {map.workers.map((worker) => (
        <View key={worker.id} style={styles.indent}>
          <NodeRow node={worker} styles={styles} theme={theme} />
        </View>
      ))}
      <View style={styles.row}>
        <Text style={styles.title}>Reviewer</Text>
        <Text style={styles.muted}>
          {map.reviewer.model ? `${map.reviewer.model} · ` : ""}
          {map.reviewer.state === "awake" ? "awake" : "asleep"} · woke {map.reviewer.wakes}×
        </Text>
      </View>
      {note ? <Text style={map.mixed ? styles.warn : styles.muted}>{note}</Text> : null}
    </View>
  );
}

function NodeRow({ node, styles, theme }: { node: MapNode; styles: Styles; theme: Theme }) {
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{node.title}</Text>
      <Text style={styles.muted}>
        {providerLabel(node.provider)} · {node.model}
      </Text>
      <Text style={[styles.state, { color: stateColor(node.state, theme) }]}>{node.state}</Text>
    </View>
  );
}

function stateColor(state: NodeState, theme: Theme) {
  const c = theme.colors;
  return state === "running" ? c.statusSuccess : state === "error" ? c.statusDanger : c.foregroundMuted;
}

type Styles = ReturnType<typeof createStyles>;

function createStyles(theme: Theme) {
  const c = theme.colors;
  return {
    wrap: { gap: 6 },
    sectionLabel: { color: c.foregroundMuted, fontSize: 11, letterSpacing: 0.8, fontWeight: "600" as const },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      flexWrap: "wrap" as const,
      gap: 8,
      padding: 10,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      backgroundColor: c.surface1,
    },
    indent: { marginLeft: 16 },
    title: { color: c.foreground, fontSize: 13, fontWeight: "600" as const },
    muted: { color: c.foregroundMuted, fontSize: 12.5 },
    warn: { color: c.statusDanger, fontSize: 12.5 },
    state: { fontSize: 11.5, marginLeft: "auto" as const },
  };
}
