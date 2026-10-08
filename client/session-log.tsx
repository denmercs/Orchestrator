import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { LOOP_AGENT_KIND } from "../shared/initiative-loop";
import {
  logLine,
  mergeOlder,
  mergeTail,
  stepTitle,
  storySessions,
  type LogLine,
  type LogPage,
  type LogState,
} from "./session-log-model";
import { SkeletonRows } from "./skeleton";

// Every session the initiative loop ran for one story (Plan, Implement, Review, Open PR, Fix CI),
// oldest first, each with its timeline. The newest session is open and follows its tail while the
// drawer is open; older ones open on tap and page back with "Load earlier".

type Theme = PluginSurfaceProps["theme"];
type Navigation = PluginSurfaceProps["navigation"];
type PaseoApi = ReturnType<typeof usePaseo>;
type Agent = Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"][number]["agent"];

const POLL_MS = 3000;
const PAGE = 100;
const LIVE = new Set(["running", "initializing"]);

function timeOf(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function fetchPage(paseo: PaseoApi, agentId: string, cursor?: LogState["olderCursor"]): Promise<LogPage> {
  const page = await paseo.agents.ref(agentId).timeline.refetch({
    direction: cursor ? "before" : "tail",
    ...(cursor ? { cursor } : {}),
    limit: PAGE,
    projection: "projected",
  });
  if (page.error) throw new Error(page.error);
  return page;
}

export function SessionLog({
  storyId,
  initiative,
  workspace,
  currentAgent,
  theme,
  navigation,
}: {
  storyId: string;
  initiative: string;
  workspace: string;
  // The drawer's "Open session" already opens this one, so its block has no Open of its own.
  currentAgent: string;
  theme: Theme;
  navigation: Navigation;
}) {
  const paseo = usePaseo();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const listed = await paseo.agents.list({
          filter: {
            labels: { kind: LOOP_AGENT_KIND, "loop-initiative": initiative, "loop-story": storyId },
            includeArchived: true,
          },
          sort: [{ key: "created_at", direction: "asc" }],
          page: { limit: 50 },
        });
        if (cancelled) return;
        setAgents(storySessions(listed.entries.map((entry) => entry.agent), workspace));
        setError(null);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not list the story's sessions.");
      }
    }
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [paseo, storyId, initiative, workspace]);

  if (error && !agents) return <Text style={styles.error}>{error}</Text>;
  if (!agents) return <SkeletonRows theme={theme} rows={3} />;
  if (!agents.length) return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.sectionLabel}>SESSIONS</Text>
      {agents.map((agent, index) => (
        <SessionBlock
          key={agent.id}
          agent={agent}
          latest={index === agents.length - 1}
          openable={agent.id !== currentAgent}
          styles={styles}
          theme={theme}
          navigation={navigation}
        />
      ))}
    </View>
  );
}

function SessionBlock({
  agent,
  latest,
  openable,
  styles,
  theme,
  navigation,
}: {
  agent: Agent;
  latest: boolean;
  openable: boolean;
  styles: Styles;
  theme: Theme;
  navigation: Navigation;
}) {
  const paseo = usePaseo();
  const [open, setOpen] = useState(latest);
  const [log, setLog] = useState<LogState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const live = LIVE.has(agent.status);

  // Opens when it becomes the newest session; an older one stays however you left it.
  useEffect(() => {
    if (latest) setOpen(true);
  }, [latest]);

  // One tail request at a time, so a slow response can't land after a newer one and roll the log back.
  const fetching = useRef(false);
  const refreshTail = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const tail = await fetchPage(paseo, agent.id);
      setLog((current) => mergeTail(current, tail));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the log.");
    } finally {
      fetching.current = false;
    }
  }, [paseo, agent.id]);

  useEffect(() => {
    if (!open) return;
    void refreshTail();
    if (!live) return;
    const timer = setInterval(() => void refreshTail(), POLL_MS);
    return () => clearInterval(timer);
  }, [open, live, refreshTail]);

  async function loadOlder() {
    if (!log?.olderCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await fetchPage(paseo, agent.id, log.olderCursor);
      setLog((current) => (current ? mergeOlder(current, page) : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load earlier entries.");
    } finally {
      setLoadingOlder(false);
    }
  }

  const lines = useMemo(() => (log ? log.entries.map(logLine).filter((line): line is LogLine => line !== null) : []), [log]);
  const tone = agent.status === "error" ? theme.colors.statusDanger : live ? theme.colors.accent : theme.colors.foregroundMuted;

  return (
    <View style={styles.session}>
      <View style={styles.sessionHead}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`${open ? "Hide" : "Show"} the ${stepTitle(agent)} log`}
          onPress={() => setOpen((value) => !value)}
          style={styles.sessionToggle}
        >
          <Text style={styles.caret}>{open ? "▾" : "▸"}</Text>
          <Text style={styles.sessionTitle} numberOfLines={1}>
            {stepTitle(agent)}
          </Text>
          <Text style={[styles.status, { color: tone }]}>{agent.archivedAt ? "archived" : agent.status}</Text>
        </Pressable>
        {navigation && openable && !agent.archivedAt ? (
          <Pressable accessibilityRole="button" onPress={() => navigation.openAgent({ agentId: agent.id })} style={styles.open}>
            <Text style={styles.openText}>Open</Text>
          </Pressable>
        ) : null}
      </View>
      {open ? (
        <View style={styles.lines}>
          {log?.hasOlder ? (
            <Pressable accessibilityRole="button" disabled={loadingOlder} onPress={() => void loadOlder()} style={styles.older}>
              <Text style={styles.openText}>{loadingOlder ? "Loading…" : "Load earlier"}</Text>
            </Pressable>
          ) : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {!log && !error ? <SkeletonRows theme={theme} rows={3} /> : null}
          {log && !lines.length ? <Text style={styles.muted}>Nothing logged yet.</Text> : null}
          {lines.map((line) => (
            <Line key={line.key} line={line} styles={styles} theme={theme} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const KIND_LABEL: Record<LogLine["kind"], string> = {
  prompt: "Prompt",
  reply: "Agent",
  thinking: "Thinking",
  tool: "Tool",
  todo: "Tasks",
  error: "Error",
  note: "Note",
};

function Line({ line, styles, theme }: { line: LogLine; styles: Styles; theme: Theme }) {
  const [expanded, setExpanded] = useState(false);
  const expandable = line.body.trim() !== "" && line.body.trim() !== line.title;
  const tone = line.failed
    ? theme.colors.statusDanger
    : line.kind === "prompt"
      ? theme.colors.accent
      : line.kind === "reply"
        ? theme.colors.foreground
        : theme.colors.foregroundMuted;

  return (
    <Pressable
      accessibilityRole={expandable ? "button" : undefined}
      accessibilityState={expandable ? { expanded } : undefined}
      disabled={!expandable}
      onPress={() => setExpanded((value) => !value)}
      style={styles.line}
    >
      <View style={styles.lineHead}>
        <Text style={[styles.kind, { color: tone }]}>{KIND_LABEL[line.kind]}</Text>
        <Text style={[styles.lineTitle, line.kind === "tool" ? styles.mono : null]} numberOfLines={expanded ? undefined : 2}>
          {line.title || "…"}
        </Text>
        <Text style={styles.time}>{timeOf(line.timestamp)}</Text>
      </View>
      {expanded ? (
        <Text style={[styles.body, line.kind === "tool" ? styles.mono : null]} selectable>
          {line.body.trim()}
        </Text>
      ) : null}
    </Pressable>
  );
}

type Styles = ReturnType<typeof createStyles>;

function createStyles(theme: Theme) {
  const c = theme.colors;
  return {
    wrap: { gap: 8 },
    sectionLabel: { color: c.foregroundMuted, fontSize: 11, letterSpacing: 0.8, fontWeight: "600" as const },
    muted: { color: c.foregroundMuted, fontSize: 12.5 },
    error: { color: c.statusDanger, fontSize: 12.5 },
    session: { borderWidth: 1, borderColor: c.border, borderRadius: 10, overflow: "hidden" as const },
    sessionHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingRight: 8, backgroundColor: c.surface1 },
    sessionToggle: {
      flex: 1,
      minWidth: 0,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      minHeight: 40,
      paddingHorizontal: 12,
    },
    caret: { color: c.foregroundMuted, fontSize: 12, width: 10 },
    sessionTitle: { flexShrink: 1, color: c.foreground, fontSize: 13, fontWeight: "600" as const },
    status: { fontSize: 11.5 },
    open: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: c.border },
    openText: { color: c.foreground, fontSize: 12 },
    older: { alignSelf: "flex-start" as const, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: c.border },
    lines: { padding: 10, gap: 2 },
    line: { paddingVertical: 5, gap: 4 },
    lineHead: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 8 },
    kind: { width: 58, fontSize: 11, fontWeight: "600" as const, paddingTop: 1 },
    lineTitle: { flex: 1, minWidth: 0, color: c.foreground, fontSize: 12.5 },
    time: { color: c.foregroundMuted, fontSize: 11, paddingTop: 1 },
    body: {
      color: c.foreground,
      fontSize: 12,
      padding: 8,
      borderRadius: 6,
      backgroundColor: c.surface2,
    },
    mono: { fontFamily: "monospace" },
  };
}
