import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { openExternalUrl, usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import {
  createHarnessEpicRpc,
  deleteEpicInitiative,
  getEpicBoards,
  listHarnessInitiatives,
  phaseLabel,
  planHarnessPhaseRpc,
  openPhasePlanRpc,
  refreshPhasePlanRpc,
  type EpicBoard,
  type EpicBoardState,
  type EpicStory,
  type HarnessRepo,
  type HarnessTracker,
} from "../shared/orchestration";
import { contextSessionsRpc, type ContextStatus } from "../shared/context";
import { gateAct, needsYou } from "../shared/gates";
import { initiativeStatus, stepBar, type InitiativeBadge, type Segment as StepSegment } from "../shared/story-steps";
import { harnessSettings } from "../shared/settings";
import { startInitiativeLoop, stopInitiativeLoop } from "../shared/initiative-loop";
import { LoadingState } from "./loading-state";
import { SelectedStoryPanel } from "./selected-story-panel";
import { SessionLog } from "./session-log";
import { SkeletonBar, SkeletonCards, SkeletonRows } from "./skeleton";
import {
  boardKey,
  contextAgents,
  edgeTone,
  emptyLine,
  findSelected,
  mergedProgress,
  nodeContext,
  nodeKind,
  pollDelay,
  sectionAction,
  sectionLine,
  sectionNote,
  showFold,
  toggleFold,
  type EdgeTone,
  type NodeContext,
  type NodeKind,
  type Selection,
} from "./epic-board-model";

// Every initiative's current phase (see server/harness-layout.ts) as its dependency graph: one
// card per story, arrows from a dependency to the stories that need it. Initiatives are occasional
// work; day-to-day epics come from Jira. Each graph starts open and folds to its header row.

type Theme = PluginSurfaceProps["theme"];
type Navigation = PluginSurfaceProps["navigation"];
type Styles = ReturnType<typeof createStyles>;

const W = 184;
const H = 88;
const GX = 72;
const GY = 14;
const P = 8;

const STATUS_LABELS: Record<string, string> = {
  todo: "To do",
  planning: "Planning",
  "awaiting-approval": "Awaiting approval",
  implementing: "Implementing",
  reviewing: "Review",
  "pr-open": "PR open",
  merged: "Merged",
  blocked: "Blocked",
};
const labelOf = (status: string) => STATUS_LABELS[status] ?? status;

function toneOf(status: string, theme: Theme) {
  const c = theme.colors;
  if (status === "merged" || status === "pr-open") return c.statusSuccess;
  if (status === "blocked") return c.statusDanger;
  if (status === "awaiting-approval") return c.statusWarning;
  if (status === "todo") return c.foregroundMuted;
  return c.accent;
}

// Colours for the board's legend kinds, the step bar's segments, the $ bar's levels and the badge.
// All from theme.colors so light and dark both work.
function kindTone(kind: NodeKind, theme: Theme) {
  const c = theme.colors;
  if (kind === "merged" || kind === "ready") return c.statusSuccess;
  if (kind === "needs-you") return c.statusWarning;
  if (kind === "running") return c.accent;
  return c.border;
}

const SEGMENT_STYLES: Record<StepSegment, (theme: Theme) => { backgroundColor: string; opacity?: number }> = {
  done: (theme) => ({ backgroundColor: theme.colors.statusSuccess, opacity: 0.45 }),
  now: (theme) => ({ backgroundColor: theme.colors.statusSuccess }),
  gate: (theme) => ({ backgroundColor: theme.colors.statusWarning }),
  todo: (theme) => ({ backgroundColor: theme.colors.border }),
};

function levelTone(level: NodeContext["level"], theme: Theme) {
  const c = theme.colors;
  if (level === "red") return c.statusDanger;
  if (level === "amber") return c.statusWarning;
  if (level === "ok") return c.statusSuccess;
  return c.foregroundMuted;
}

const BADGE_TONES: Record<InitiativeBadge, (theme: Theme) => string> = {
  "Needs plan": (theme) => theme.colors.foregroundMuted,
  Planning: (theme) => theme.colors.statusWarning,
  Done: (theme) => theme.colors.statusSuccess,
  "Needs you": (theme) => theme.colors.statusWarning,
  "In progress": (theme) => theme.colors.accent,
  Ready: (theme) => theme.colors.accent,
};

function iconOf(story: EpicStory) {
  if (needsYou(story)) return "AlertCircle";
  if (story.status === "merged") return "CheckCircle";
  if (story.status === "todo") return "Circle";
  return "Loader";
}

type StoryGroup = { key: string; label: string; stories: EpicStory[] };

// The phone list: what needs you first, then what is running, what is next, and merged work last.
function statusGroups(stories: EpicStory[]): StoryGroup[] {
  const groups: StoryGroup[] = [
    { key: "you", label: "Needs you", stories: stories.filter(needsYou) },
    {
      key: "progress",
      label: "In progress",
      stories: stories.filter((item) => !needsYou(item) && item.status !== "todo" && item.status !== "merged"),
    },
    {
      key: "next",
      label: "Up next",
      stories: stories.filter((item) => item.status === "todo").sort((a, b) => Number(b.ready) - Number(a.ready)),
    },
    { key: "merged", label: "Merged", stories: stories.filter((item) => item.status === "merged") },
  ];
  return groups.filter((group) => group.stories.length > 0);
}

// Columns are dependency depth. Within a column, stories sit near the stories they depend on
// (mean row of their dependencies), which keeps arrows short and mostly uncrossed.
function layout(stories: EpicStory[]) {
  const byId = new Map(stories.map((story) => [story.id, story]));
  const depth = new Map<string, number>();
  const depthOf = (id: string, seen = new Set<string>()): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const deps = (byId.get(id)?.dependsOn ?? []).filter((dep) => byId.has(dep));
    const value = deps.length ? 1 + Math.max(...deps.map((dep) => depthOf(dep, seen))) : 0;
    depth.set(id, value);
    return value;
  };
  const cols: EpicStory[][] = [];
  for (const story of stories) {
    (cols[depthOf(story.id)] ??= []).push(story);
  }
  const row = new Map<string, number>();
  cols.forEach((col, ci) => {
    if (ci > 0) {
      const key = (story: EpicStory) => {
        const rows = story.dependsOn.map((dep) => row.get(dep)).filter((r): r is number => r !== undefined);
        return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Number.POSITIVE_INFINITY;
      };
      col.sort((a, b) => key(a) - key(b));
    }
    col.forEach((story, ri) => row.set(story.id, ri));
  });
  return { byId, cols, depth, row };
}

type Segment = { x: number; y: number; w: number; h: number; color: string; hot: boolean; failed: boolean };
type Arrow = { x: number; y: number; color: string };

const EDGE_COLORS: Record<EdgeTone, (theme: Theme) => string> = {
  danger: (theme) => theme.colors.statusDanger,
  success: (theme) => theme.colors.statusSuccess,
  muted: (theme) => theme.colors.foregroundMuted,
};

// Elbow arrows built from plain views (no SVG in plugins): out of the dependency, down its
// own channel in the gap, into the story. An arrow that skips a column runs along the gap
// between rows so it never crosses a card.
function edgesFor(stories: EpicStory[], selected: string | null, theme: Theme) {
  const { byId, cols, depth, row } = layout(stories);
  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((col, ci) => col.forEach((story, ri) => pos.set(story.id, { x: P + ci * (W + GX), y: P + ri * (H + GY) })));
  const maxRows = Math.max(1, ...cols.map((col) => col.length));
  const segments: Segment[] = [];
  const arrows: Arrow[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number, color: string, hot: boolean, failed = false) => {
    const t = hot || failed ? 2 : 1.5;
    segments.push({
      x: Math.min(x1, x2) - (x1 === x2 ? t / 2 : 0),
      y: Math.min(y1, y2) - (y1 === y2 ? t / 2 : 0),
      w: x1 === x2 ? t : Math.abs(x2 - x1) + (y1 === y2 ? 0 : t),
      h: y1 === y2 ? t : Math.abs(y2 - y1) + t,
      color,
      hot,
      failed,
    });
  };
  for (const story of stories) {
    const b = pos.get(story.id);
    if (!b) continue;
    for (const dep of story.dependsOn) {
      const a = pos.get(dep);
      if (!a) continue;
      const hot = selected === story.id || selected === dep;
      const tone = edgeTone(story, byId.get(dep));
      const failed = tone === "danger";
      const color = hot ? theme.colors.accent : EDGE_COLORS[tone](theme);
      const lane = (row.get(dep) ?? 0) % 4;
      const x1 = a.x + W;
      const y1 = a.y + H / 2;
      const x2 = b.x - 6;
      const y2 = b.y + H / 2;
      const out = x1 + 14 + lane * 12;
      const span = (depth.get(story.id) ?? 0) - (depth.get(dep) ?? 0);
      if (span <= 1) {
        line(x1, y1, out, y1, color, hot, failed);
        line(out, y1, out, y2, color, hot, failed);
        line(out, y2, x2, y2, color, hot, failed);
      } else {
        // Nearest horizontal gap between rows to halfway, then across to the gap before the story.
        const mid = (y1 + y2) / 2;
        let gapY = P - GY / 2;
        for (let r = 0; r <= maxRows; r += 1) {
          const y = P + r * (H + GY) - GY / 2;
          if (Math.abs(y - mid) < Math.abs(gapY - mid)) gapY = y;
        }
        const inX = b.x - 14 - lane * 12;
        line(x1, y1, out, y1, color, hot, failed);
        line(out, y1, out, gapY, color, hot, failed);
        line(out, gapY, inX, gapY, color, hot, failed);
        line(inX, gapY, inX, y2, color, hot, failed);
        line(inX, y2, x2, y2, color, hot, failed);
      }
      arrows.push({ x: x2, y: y2, color });
    }
  }
  const width = P * 2 + cols.length * W + Math.max(0, cols.length - 1) * GX;
  const height = P * 2 + maxRows * (H + GY) - GY;
  // Failed, then highlighted arrows draw last so they sit on top of shared channels.
  const rank = (seg: Segment) => (seg.hot ? 2 : seg.failed ? 1 : 0);
  segments.sort((s1, s2) => rank(s1) - rank(s2));
  return { cols, pos, segments, arrows, width, height };
}

export type EpicBoards = {
  boards: EpicBoard[] | null;
  error: string | null;
  selected: Selection | null;
  select(board: EpicBoard, story: string | null): void;
  folded: ReadonlySet<string>;
  toggleFold(board: EpicBoard): void;
  // Unfolds a panel and opens one of its stories, by keys (an alert names them without the board).
  reveal(board: string, story: string): void;
  refresh(): Promise<void>;
  // Wide layouts show the selected story inline; its drawer opens only on Details.
  details: boolean;
  showDetails(open: boolean): void;
};

// The initiative boards as data: the latest read, polled, plus which story is open and which
// panels are folded. Held by the dashboard so the header can read it and the views can come and go
// without losing selection or folds.
export function useEpicBoards(): EpicBoards {
  const paseo = usePaseo();
  const loadBoards = useRpc(getEpicBoards);
  const settings = useSettings(harnessSettings);
  const [boards, setBoards] = useState<EpicBoard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [details, setDetails] = useState(false);

  // Actions refresh on their own, so a slow older read can land after a newer one; only the
  // newest result is kept (a deleted initiative must not come back).
  const reads = useRef({ started: 0, applied: 0 });
  const refresh = useCallback(async () => {
    const id = ++reads.current.started;
    try {
      const { projects } = await paseo.projects.list();
      const result = await loadBoards({ repos: projects.map((project) => project.projectRootPath) });
      if (id < reads.current.applied) return;
      reads.current.applied = id;
      setBoards(result.boards);
      setError(null);
    } catch (cause) {
      if (id < reads.current.applied) return;
      setError(cause instanceof Error ? cause.message : "Unable to read the initiatives");
    }
  }, [paseo, loadBoards]);

  // The next poll waits for the last one, so a slow read (the first `gh` lookup per repo) can't
  // stack up requests.
  const delay = useRef(pollDelay(null));
  useEffect(() => {
    delay.current = pollDelay(boards);
  }, [boards]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(() => void tick(), delay.current);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [refresh]);

  // Picking a different phase starts with nothing selected.
  const settingsKey = settings.status === "ready" ? `${settings.values.repo}\n${settings.values.epic}` : "";
  useEffect(() => {
    setSelected(null);
    void refresh();
  }, [settingsKey, refresh]);

  const select = useCallback((board: EpicBoard, story: string | null) => {
    setSelected(story ? { board: boardKey(board), story } : null);
    if (!story) setDetails(false);
  }, []);
  const toggle = useCallback((board: EpicBoard) => {
    setFolded((current) => toggleFold(current, boardKey(board)));
  }, []);
  const reveal = useCallback((board: string, story: string) => {
    setFolded((current) => showFold(current, board));
    setSelected({ board, story });
  }, []);

  return { boards, error, selected, select, folded, toggleFold: toggle, reveal, refresh, details, showDetails: setDetails };
}

type ViewProps = { epic: EpicBoards; theme: Theme; compact: boolean; navigation: Navigation };

// One panel per initiative, for the dashboard's scroll view, or the picker while choosing a phase.
// `onEditPolicy` opens where the context policy is edited (the Story pipeline drawer).
export function InitiativePanels({ epic, theme, compact, navigation, onEditPolicy }: ViewProps & { onEditPolicy?(): void }) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const settings = useSettings(harnessSettings);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const { boards, error, selected, refresh } = epic;

  // Picking or creating a phase shows it on its initiative's board.
  async function pointAt(next: Partial<{ repo: string; epic: string }>) {
    if (settings.status !== "ready") return;
    const saved = await settings.save({ ...settings.values, ...next }, settings.revision);
    if (saved) setEditing(false);
    else toast.error(settings.saveError ?? "Could not save the initiative repo.");
    void refresh();
  }

  if (editing) {
    return (
      <View style={styles.panel}>
        <HarnessPicker
          styles={styles}
          theme={theme}
          active={settings.status === "ready" ? settings.values : null}
          onPicked={(next) => void pointAt(next)}
          onOpenAgent={navigation ? (agentId) => navigation.openAgent({ agentId }) : null}
          onCancel={() => {
            setEditing(false);
            void refresh();
          }}
        />
      </View>
    );
  }

  // First load only: once boards arrive, later refreshes keep them on screen; errors keep their text.
  if (boards === null && !error) {
    return (
      <LoadingState theme={theme} compact={compact}>
        <SkeletonCards theme={theme} count={2} height={compact ? 120 : 160} compact />
      </LoadingState>
    );
  }

  if (!boards?.length) {
    return (
      <View style={[styles.panel, styles.folded]}>
        <Text style={styles.foldedTitle}>Initiatives</Text>
        <Text style={[error ? styles.danger : styles.muted, styles.flex]} numberOfLines={1}>
          {error ?? "not set up"}
        </Text>
        <Button label="Initiatives" styles={styles} onPress={() => setEditing(true)} />
      </View>
    );
  }

  return (
    <View style={styles.screenFill}>
      {error ? (
        <Text style={styles.danger} numberOfLines={2}>
          Couldn't refresh the initiatives, showing the last read: {error}
        </Text>
      ) : null}
      <Legend theme={theme} styles={styles} compact={compact} />
      {boards.map((board) => {
        const key = boardKey(board);
        return (
          <InitiativePanel
            key={key}
            board={board}
            theme={theme}
            styles={styles}
            compact={compact}
            navigation={navigation}
            selected={selected?.board === key ? selected.story : null}
            folded={epic.folded.has(key)}
            onToggleFold={() => epic.toggleFold(board)}
            onSelect={(id) => epic.select(board, id)}
            onPicker={() => setEditing(true)}
            onChanged={() => void refresh()}
            onDetails={() => epic.showDetails(true)}
            onEditPolicy={onEditPolicy}
          />
        );
      })}
    </View>
  );
}

// What the node borders, step bar and $ bar mean. Compact has no arrows, so no arrow sentence.
function Legend({ theme, styles, compact }: { theme: Theme; styles: Styles; compact: boolean }) {
  const c = theme.colors;
  const swatch = (label: string, kind: NodeKind) => (
    <View key={label} style={styles.legendItem}>
      <View
        style={[
          styles.legendSwatch,
          { borderColor: kindTone(kind, theme) },
          kind === "merged" ? { backgroundColor: kindTone(kind, theme) } : null,
        ]}
      />
      <Text style={styles.hint}>{label}</Text>
    </View>
  );
  return (
    <View style={styles.legend}>
      <Text style={styles.legendTitle}>Initiatives</Text>
      {compact ? null : <Text style={styles.hint}>Arrows point from a dependency to the story that needs it</Text>}
      <View style={styles.flex} />
      {swatch("Merged", "merged")}
      {swatch("Ready", "ready")}
      {swatch("Running", "running")}
      {swatch("Needs you", "needs-you")}
      {swatch("Waiting", "waiting")}
      <View style={styles.legendItem}>
        <View style={styles.legendSegments}>
          {(["done", "now", "todo"] as const).map((seg) => (
            <View key={seg} style={[styles.legendSegment, SEGMENT_STYLES[seg](theme)]} />
          ))}
        </View>
        <Text style={styles.hint}>▸ Phases</Text>
      </View>
      <View style={styles.legendItem}>
        <Text style={[styles.hint, { color: c.statusWarning, fontWeight: "600" }]}>$</Text>
        <Text style={styles.hint}>Context used</Text>
      </View>
    </View>
  );
}

// A story's five-segment step bar (Plan, Implement, Review, PR, CI watch).
function StepBarView({ story, stories, theme, styles }: { story: EpicStory; stories: EpicStory[]; theme: Theme; styles: Styles }) {
  return (
    <View style={styles.barRow} accessibilityLabel="Phases: Plan · Implement · Review · PR · CI watch">
      <Text style={styles.barGlyph}>▸</Text>
      <View style={styles.segments}>
        {stepBar(story, "plan", stories).segments.map((seg, i) => (
          <View key={i} style={[styles.segment4, SEGMENT_STYLES[seg](theme)]} />
        ))}
      </View>
      <View style={styles.barEnd} />
    </View>
  );
}

// A running story's context: how full, coloured by level, with a red tick where it should act.
function ContextBarView({ context, theme, styles }: { context: NodeContext; theme: Theme; styles: Styles }) {
  const tone = levelTone(context.level, theme);
  return (
    <View style={styles.barRow} accessibilityLabel={`Context used ${context.label}`}>
      <Text style={[styles.barGlyph, { color: tone, fontWeight: "600" }]}>$</Text>
      <View style={styles.ctxTrack}>
        <View style={[styles.ctxFill, { width: `${context.pct}%`, backgroundColor: tone }]} />
        <View style={[styles.ctxAct, { left: `${context.act}%`, backgroundColor: theme.colors.statusDanger }]} />
      </View>
      <Text style={[styles.barEnd, styles.ctxLabel, { color: tone }]}>{context.label}</Text>
    </View>
  );
}

// The selected story's drawer, mounted at the screen root so it covers the whole surface. Renders
// nothing while no story is selected; on wide layouts only once the inline panel's Details asks.
export function StoryDrawer({ epic, theme, compact, navigation }: ViewProps) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const open = findSelected(epic.boards, epic.selected);
  if (!open?.board.state || (!compact && !epic.details)) return null;
  const { board, story } = open;
  return (
    <StoryDrawerView
      story={story}
      state={open.board.state}
      board={boardKey(board)}
      onChanged={() => void epic.refresh()}
      theme={theme}
      styles={styles}
      onClose={() => (compact ? epic.select(board, null) : epic.showDetails(false))}
      onSelect={(id) => epic.select(board, id)}
      navigation={navigation}
    />
  );
}

// One initiative's current phase as its dependency graph (or grouped list when compact), with its
// loop and plan actions. Each panel folds to its header row with the chevron.
function InitiativePanel({
  board,
  theme,
  styles,
  compact,
  navigation,
  selected,
  folded,
  onToggleFold,
  onSelect,
  onPicker,
  onChanged,
  onDetails,
  onEditPolicy,
}: {
  board: EpicBoard;
  theme: Theme;
  styles: Styles;
  compact: boolean;
  navigation: Navigation;
  selected: string | null;
  folded: boolean;
  onToggleFold(): void;
  onSelect(id: string | null): void;
  onPicker(): void;
  onChanged(): void;
  onDetails(): void;
  onEditPolicy?(): void;
}) {
  const removeInitiative = useRpc(deleteEpicInitiative);
  const openPlan = useRpc(openPhasePlanRpc);
  const paseo = usePaseo();
  const refreshPlan = useRpc(refreshPhasePlanRpc);
  const startLoop = useRpc(startInitiativeLoop);
  const stopLoop = useRpc(stopInitiativeLoop);
  const planArchitecture = useRpc(planHarnessPhaseRpc);
  const loadContext = useRpc(contextSessionsRpc);
  const toast = useToast();
  const { repo, state, error } = board;
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [listView, setListView] = useState<"status" | "step">("status");
  const [mergedOpen, setMergedOpen] = useState(false);
  const [context, setContext] = useState<ReadonlyMap<string, ContextStatus | null>>(() => new Map());

  // The running stories' context, one batched call per board poll (each poll is a new `state`).
  // A failed read leaves the $ bars off rather than showing stale numbers. A folded section shows
  // no bars, so it asks for nothing.
  const agentKey = state && !folded ? contextAgents(state.stories).join("\n") : "";
  useEffect(() => {
    if (!agentKey) {
      setContext((current) => (current.size ? new Map() : current));
      return;
    }
    let cancelled = false;
    const agentIds = agentKey.split("\n");
    loadContext({ agentIds })
      .then((results) => {
        if (!cancelled) setContext(new Map(agentIds.map((id, i) => [id, results[i] ?? null])));
      })
      .catch(() => {
        if (!cancelled) setContext(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [agentKey, state, loadContext]);

  // Opens the plan in Paseo's browser (desktop app), in the repo's workspace; elsewhere in the
  // system browser. The page reloads itself as architecture.md changes.
  async function showPlan(ref: { repo: string; epic: string }) {
    try {
      const result = await openPlan(ref);
      if (!result.ok || !result.url) {
        toast.error(result.error ?? "Could not open the plan.");
        return;
      }
      const openBrowser = navigation?.openBrowser;
      if (openBrowser) {
        const workspace = await paseo.workspaces.open({ cwd: ref.repo });
        openBrowser({ url: result.url, workspaceId: workspace.id });
      } else {
        await openExternalUrl(result.url);
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not open the plan.");
    }
  }

  // The first time a phase's plan appears while the board is open (the architecture session just
  // wrote it), open it once.
  const planShown = useRef(new Map<string, boolean>());
  const planPhase = state ? state.epic.dir : "";
  const hasPlan = Boolean(state?.plan);
  useEffect(() => {
    if (!planPhase) return;
    const before = planShown.current.get(planPhase);
    planShown.current.set(planPhase, hasPlan);
    if (before === false && hasPlan) void showPlan({ repo, epic: planPhase });
  }, [repo, planPhase, hasPlan]);

  // The phase's architecture plan: open its HTML view, or pull Jira status into it (one way).
  async function planAction(kind: "open" | "jira") {
    if (!planPhase || busy !== null) return;
    const ref = { repo, epic: planPhase };
    setBusy(`plan-${kind}:`);
    try {
      if (kind === "open") {
        await showPlan(ref);
        return;
      }
      const result = await refreshPlan(ref);
      if (!result.ok) toast.error(result.error ?? "Could not refresh from Jira.");
      else if (result.keys === 0) toast.show("No Jira keys in this plan yet.");
      else {
        const missing = result.missing.length ? ` Not found: ${result.missing.join(", ")}.` : "";
        toast.show(`Refreshed ${result.keys} keys from Jira, ${result.changed} changed.${missing}`, { variant: "success" });
      }
    } finally {
      setBusy(null);
    }
  }

  // Start runs the initiative's stories phase by phase; Stop only stops new work from starting.
  async function loopAction(kind: "start" | "stop") {
    if (!state || busy !== null) return;
    const ref = { repo, initiative: state.initiativeSlug };
    setBusy(`loop-${kind}:`);
    try {
      if (kind === "stop") {
        const result = await stopLoop(ref);
        if (!result.ok) toast.error(result.error ?? "Could not stop the loop.");
        else toast.show("Loop stopped. Running agents keep going; nothing new starts.");
        return;
      }
      const result = await startLoop(ref);
      if (!result.ok) {
        toast.error(result.error ?? "Could not start the loop.");
        return;
      }
      const ids = result.started.map((item) => item.story).join(", ");
      toast.show(ids ? `Loop started: planning ${ids}.` : `Loop on. ${result.reason}.`, { variant: "success" });
      const first = result.started[0];
      if (first && navigation) navigation.openAgent({ agentId: first.agentId });
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not change the loop.");
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  // An empty initiative with no plan: start (or resume) its architecture session.
  async function startPlanning() {
    if (!planPhase || busy !== null) return;
    setBusy("plan-phase:");
    try {
      const result = await planArchitecture({ repo, epic: planPhase });
      if (!result.ok) {
        toast.error(result.error ?? "Could not start the architecture session.");
        return;
      }
      toast.show("Architecture session started.", { variant: "success" });
      if (result.agentId && navigation) navigation.openAgent({ agentId: result.agentId });
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not start the architecture session.");
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  // Deleting removes the initiative's files for good (.harness is not in git); its panel goes away
  // on the next refresh.
  async function deleteInitiative() {
    if (busy || !planPhase) return;
    setBusy("delete:");
    try {
      const result = await removeInitiative({ repo, epic: planPhase });
      if (!result.ok) {
        toast.error(result.error ?? "Could not delete the initiative.");
        return;
      }
      toast.show(`Deleted ${result.deleted}`, { variant: "success" });
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not delete the initiative.");
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  if (!state) {
    return (
      <View style={styles.panel}>
        <View style={styles.head}>
          <Text style={[styles.panelTitle, styles.flex]}>{board.initiative}</Text>
          <Button label="Initiatives" styles={styles} onPress={onPicker} />
        </View>
        {error ? (
          <Text style={styles.danger}>{error}</Text>
        ) : (
          <LoadingState theme={theme} compact={compact}>
            <SkeletonBar theme={theme} width="40%" height={16} />
            <SkeletonRows theme={theme} rows={4} />
          </LoadingState>
        )}
      </View>
    );
  }

  const stories = state.stories;
  const progress = mergedProgress(stories);
  const left = progress.total - progress.merged;
  const graph = edgesFor(stories, selected, theme);
  const initiative = state.initiative || "Initiative";
  const selectedStory = stories.find((item) => item.id === selected) ?? null;
  const badge = initiativeStatus(state);
  const badgeTone = BADGE_TONES[badge](theme);
  const note = sectionNote(state);
  const empty = stories.length === 0;

  const card = (item: EpicStory, at: { x: number; y: number } | undefined) => {
    const kind = nodeKind(item);
    const tone = kindTone(kind, theme);
    const bar = stepBar(item, "plan", stories);
    const ctx = item.agent ? nodeContext(context.get(item.agent) ?? null) : null;
    const isSelected = item.id === selected;
    return (
      <Pressable
        key={item.id}
        accessibilityRole="button"
        accessibilityState={{ selected: isSelected }}
        accessibilityLabel={`${item.id}, ${item.title}, ${bar.sub}${ctx ? `, context ${ctx.label}` : ""}`}
        onPress={() => onSelect(isSelected ? null : item.id)}
        style={[
          styles.node,
          { borderColor: tone },
          at ? { position: "absolute", left: at.x, top: at.y, width: W, height: H } : null,
          isSelected ? styles.nodeSelected : null,
        ]}
      >
        {kind === "merged" ? <View pointerEvents="none" style={[styles.nodeTint, { backgroundColor: tone }]} /> : null}
        <View style={styles.nodeTop}>
          <Text style={[styles.nodeId, styles.cardId, kind === "needs-you" ? { color: tone } : null]}>{item.id}</Text>
          <Text style={[styles.nodeSub, styles.shrink, { color: kind === "needs-you" ? tone : theme.colors.foregroundMuted }]} numberOfLines={1}>
            · {bar.sub}
          </Text>
        </View>
        <Text style={[styles.nodeTitle, styles.cardTitle, kind === "waiting" ? styles.mutedTitle : null]} numberOfLines={1}>
          {item.title}
        </Text>
        <StepBarView story={item} stories={stories} theme={theme} styles={styles} />
        {ctx ? <ContextBarView context={ctx} theme={theme} styles={styles} /> : null}
      </Pressable>
    );
  };

  const planning = Boolean(state.plan && state.plan.status !== "agreed");
  const canStart = state.loop === "off" && left > 0;
  // One obvious next step; everything else lives in the ⋯ menu.
  const action = sectionAction(state, busy);
  const primary =
    action?.kind === "stop"
      ? { label: action.label, primary: false, onPress: () => void loopAction("stop") }
      : action?.kind === "start"
        ? { label: action.label, primary: true, onPress: () => void loopAction("start") }
        : action?.kind === "plan"
          ? { label: action.label, primary: true, plan: true, onPress: () => void planAction("open") }
          : action?.kind === "start-planning"
            ? { label: action.label, primary: true, onPress: () => void startPlanning() }
            : null;
  const menu: MenuEntry[] = [
    ...(canStart && planning ? [{ label: "Start before planning is done", icon: "Play", onPress: () => void loopAction("start") }] : []),
    ...(state.plan && !(primary && "plan" in primary) ? [{ label: "View plan", icon: "FileText", onPress: () => void planAction("open") }] : []),
    ...(state.plan?.jira ? [{ label: "Refresh from Jira", icon: "RefreshCw", onPress: () => void planAction("jira") }] : []),
    { label: "Initiatives and phases", icon: "FolderOpen", onPress: onPicker },
    "separator",
    { label: "Delete initiative", icon: "Trash2", danger: true, onPress: () => setConfirmDelete(true) },
  ];
  // An open empty section carries its button in the dashed box instead of the header.
  const headerAction = primary && !(empty && !folded) ? primary : null;

  const row = (item: EpicStory, index: number) => {
    const tone = toneOf(item.status, theme);
    const bar = stepBar(item, "plan", stories);
    return (
      <Pressable
        key={item.id}
        accessibilityRole="button"
        accessibilityLabel={`${item.id}, ${item.title}, ${bar.sub}`}
        onPress={() => onSelect(item.id)}
        style={[styles.listRow, index > 0 ? styles.listRowDivider : null, item.status === "todo" && !item.ready ? styles.nodeWaiting : null]}
      >
        <Icon name={iconOf(item)} size={16} color={tone} />
        <View style={styles.listRowText}>
          <View style={styles.listRowTop}>
            <Text style={styles.nodeId}>{item.id}</Text>
            <Text style={[styles.nodeTitle, styles.shrink]} numberOfLines={1}>
              {item.title}
            </Text>
          </View>
          <Text style={[styles.hint, needsYou(item) ? { color: tone } : null]} numberOfLines={1}>
            {bar.sub}
          </Text>
          <StepBarView story={item} stories={stories} theme={theme} styles={styles} />
        </View>
        <Icon name="ChevronRight" size={16} color={theme.colors.foregroundMuted} />
      </Pressable>
    );
  };

  const list =
    listView === "status" ? (
      <View style={styles.steps}>
        {statusGroups(stories).map((group) => {
          const folded = group.key === "merged" && !mergedOpen;
          const label = `${group.label.toUpperCase()} · ${group.stories.length}`;
          return (
            <View key={group.key} style={styles.step}>
              {group.key === "merged" ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: !folded }}
                  onPress={() => setMergedOpen(!mergedOpen)}
                  style={styles.groupToggle}
                >
                  <Icon name={folded ? "ChevronRight" : "ChevronDown"} size={14} color={theme.colors.foregroundMuted} />
                  <Text style={styles.stepLabel}>{label}</Text>
                </Pressable>
              ) : (
                <Text style={styles.stepLabel}>{label}</Text>
              )}
              {folded ? null : <View style={styles.listGroup}>{group.stories.map(row)}</View>}
            </View>
          );
        })}
      </View>
    ) : (
      <View style={styles.steps}>
        {graph.cols.map((col, ci) => (
          <View key={ci} style={styles.step}>
            <Text style={styles.stepLabel}>{ci === 0 ? "STEP 1 · NO DEPENDENCIES" : `STEP ${ci + 1} · AFTER STEP ${ci}`}</Text>
            <View style={styles.listGroup}>{col.map(row)}</View>
          </View>
        ))}
      </View>
    );

  return (
    <View style={styles.screenFill}>
      <View style={[styles.panel, styles.section]}>
        <View style={styles.sectionHead}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: !folded }}
            accessibilityLabel={`${initiative}, ${badge}, ${folded ? "show" : "hide"} stories`}
            onPress={onToggleFold}
            style={styles.sectionToggle}
          >
            <Icon name={folded ? "ChevronRight" : "ChevronDown"} size={16} color={theme.colors.foregroundMuted} />
            <View style={styles.headText}>
              <View style={styles.titleRow}>
                <Text style={[styles.panelTitle, styles.shrink]} numberOfLines={1}>
                  {initiative}
                </Text>
                <Text style={[styles.chip, { color: badgeTone, borderColor: badgeTone }]}>{badge}</Text>
              </View>
              <Text style={styles.muted} numberOfLines={1}>
                {sectionLine(state)}
              </Text>
            </View>
          </Pressable>
          <View style={styles.progress}>
            <Text style={styles.progressText}>
              {progress.merged}/{progress.total} merged
            </Text>
            <View style={styles.track}>
              <View style={[styles.trackFill, { width: `${progress.pct}%`, backgroundColor: theme.colors.statusSuccess }]} />
            </View>
          </View>
          {headerAction ? (
            <Button
              label={headerAction.label}
              primary={headerAction.primary}
              disabled={busy !== null}
              styles={styles}
              onPress={headerAction.onPress}
            />
          ) : null}
          <IconButton icon="MoreHorizontal" label="More actions" theme={theme} styles={styles} onPress={() => setMenuOpen(true)} />
        </View>

        {folded ? null : (
          <View style={styles.sectionBody}>
            {error ? <Text style={styles.danger}>{error}</Text> : null}
            {note ? (
              <View style={styles.noteRow}>
                <View style={[styles.noteDot, { backgroundColor: theme.colors.statusWarning }]} />
                <Text style={[styles.noteText, { color: theme.colors.statusWarning }]}>{note}</Text>
              </View>
            ) : null}
            {state.plan?.warnings.length ? (
              <Text style={styles.hint} numberOfLines={2}>
                Plan gaps: {state.plan.warnings.join(" · ")}
              </Text>
            ) : null}

            {empty ? (
              <View style={styles.emptyBox}>
                <Text style={[styles.muted, styles.shrink]}>{emptyLine(state)}</Text>
                {primary ? (
                  <Button label={primary.label} primary={primary.primary} disabled={busy !== null} styles={styles} onPress={primary.onPress} />
                ) : null}
              </View>
            ) : compact ? (
              <>
                <Segmented<"status" | "step">
                  value={listView}
                  options={[
                    ["status", "By status"],
                    ["step", "By step"],
                  ]}
                  styles={styles}
                  onChange={setListView}
                />
                {list}
              </>
            ) : (
              <>
                <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.graphScroll}>
                  <View style={{ width: graph.width, height: graph.height }}>
                    {graph.segments.map((s, i) => (
                      <View
                        key={`s${i}`}
                        pointerEvents="none"
                        style={{
                          position: "absolute",
                          left: s.x,
                          top: s.y,
                          width: s.w,
                          height: s.h,
                          backgroundColor: s.color,
                          opacity: s.hot || s.failed ? 1 : 0.75,
                        }}
                      />
                    ))}
                    {graph.arrows.map((a, i) => (
                      <View
                        key={`a${i}`}
                        pointerEvents="none"
                        style={[styles.arrowHead, { left: a.x, top: a.y - 5, borderLeftColor: a.color }]}
                      />
                    ))}
                    {stories.map((item) => card(item, graph.pos.get(item.id)))}
                  </View>
                </ScrollView>
                {selectedStory ? (
                  <SelectedStoryPanel
                    repo={repo}
                    state={state}
                    story={selectedStory}
                    theme={theme}
                    compact={compact}
                    navigation={navigation}
                    onDetails={onDetails}
                    onEditPolicy={onEditPolicy}
                    onChanged={onChanged}
                  />
                ) : null}
              </>
            )}
          </View>
        )}
      </View>
      <ActionMenu title={initiative} open={menuOpen} onOpenChange={setMenuOpen} items={menu} theme={theme} styles={styles} />
      <Modal
        title="Delete initiative?"
        icon={<Icon name="Trash2" size={18} color={theme.colors.statusDanger} />}
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
      >
        <Modal.Content>
          <Text style={styles.bannerText}>
            This deletes {initiative} and every phase and story in it from .harness. .harness is not in git, so it can't be undone.
          </Text>
          <View style={styles.modalActions}>
            <Button label="Cancel" styles={styles} onPress={() => setConfirmDelete(false)} />
            <Button
              label={busy === "delete:" ? "Deleting…" : "Delete initiative"}
              danger
              disabled={busy !== null}
              styles={styles}
              onPress={() => {
                setConfirmDelete(false);
                void deleteInitiative();
              }}
            />
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}

function StoryDrawerView({
  story,
  state,
  board,
  onChanged,
  theme,
  styles,
  onClose,
  onSelect,
  navigation,
}: {
  story: EpicStory;
  state: EpicBoardState;
  // The board key (boardKey), for gate actions.
  board: string;
  onChanged(): void;
  theme: Theme;
  styles: Styles;
  onClose(): void;
  onSelect(id: string): void;
  navigation: Navigation;
}) {
  const tone = toneOf(story.status, theme);
  const neededBy = state.stories.filter((item) => item.dependsOn.includes(story.id));
  const prUrl = story.pr && state.repoUrl ? `${state.repoUrl}/pull/${story.pr}` : "";
  const gate = useRpc(gateAct);
  const toast = useToast();
  const [retrying, setRetrying] = useState(false);
  const blocked = story.status === "blocked";

  // Retry a blocked story (see CONTEXT.md, "Gate action"), then re-read the boards.
  async function retry() {
    if (retrying) return;
    setRetrying(true);
    try {
      const result = await gate({ board, storyId: story.id, action: "retry" });
      if (!result.ok) toast.error(result.error ?? "Could not retry.");
      else toast.show(`Retrying ${story.id}.`, { variant: "success" });
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not retry.");
    } finally {
      setRetrying(false);
      onChanged();
    }
  }

  return (
    <View style={styles.overlay}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close story" onPress={onClose} style={styles.backdrop} />
      <View style={styles.drawer} accessibilityViewIsModal>
        <View style={styles.drawerHead}>
          <Text style={[styles.badge, { color: tone, borderColor: tone }]}>{labelOf(story.status)}</Text>
          <Text style={styles.nodeId}>{story.id}</Text>
          <View style={styles.flex} />
          <Button label="Close" styles={styles} onPress={onClose} />
        </View>
        <ScrollView contentContainerStyle={styles.drawerBody}>
          <Text style={styles.drawerTitle}>{story.title}</Text>
          {story.status === "blocked" && story.blockedReason ? (
            <Text style={styles.reason}>{story.blockedReason}</Text>
          ) : null}
          {story.skillWarnings ? <Text style={styles.reason}>Skill warnings: {story.skillWarnings}</Text> : null}
          {story.status === "awaiting-approval" ? (
            <Text style={styles.muted}>The plan is ready. Open its session to ask questions, push back, or approve it.</Text>
          ) : null}
          {blocked || prUrl || (navigation && (story.agent || story.workspace)) ? (
            <View style={styles.actions}>
              {blocked ? (
                <Button label={retrying ? "Retrying…" : "Retry"} disabled={retrying} styles={styles} onPress={() => void retry()} />
              ) : null}
              {navigation && story.agent && story.status !== "merged" ? (
                <Button label="Open session" primary styles={styles} onPress={() => navigation.openAgent({ agentId: story.agent })} />
              ) : null}
              {/* Opening the session already opens its workspace, so this only shows before a session exists. */}
              {navigation && !story.agent && story.workspace && story.status !== "merged" ? (
                <Button label="Open workspace" styles={styles} onPress={() => navigation.openWorkspace({ workspaceId: story.workspace })} />
              ) : null}
              {prUrl ? (
                <Button
                  label={`Open PR #${story.pr}${story.ci ? ` · CI ${story.ci}` : ""}`}
                  styles={styles}
                  onPress={() => void openExternalUrl(prUrl)}
                />
              ) : null}
            </View>
          ) : null}

          {story.discoveredFrom ? (
            <View style={styles.related}>
              <Text style={styles.sectionLabel}>FOUND WHILE WORKING ON</Text>
              <View style={styles.actions}>
                <Button label={story.discoveredFrom} styles={styles} onPress={() => onSelect(story.discoveredFrom)} />
              </View>
            </View>
          ) : null}
          {story.dependsOn.length ? (
            <View style={styles.related}>
              <Text style={styles.sectionLabel}>DEPENDS ON</Text>
              <View style={styles.actions}>
                {story.dependsOn.map((id) => {
                  const dep = state.stories.find((item) => item.id === id);
                  return (
                    <Button
                      key={id}
                      label={dep ? `${id} · ${labelOf(dep.status)}` : id}
                      styles={styles}
                      onPress={() => dep && onSelect(id)}
                    />
                  );
                })}
              </View>
            </View>
          ) : null}
          {neededBy.length ? (
            <View style={styles.related}>
              <Text style={styles.sectionLabel}>NEEDED BY</Text>
              <View style={styles.actions}>
                {neededBy.map((item) => (
                  <Button key={item.id} label={item.id} styles={styles} onPress={() => onSelect(item.id)} />
                ))}
              </View>
            </View>
          ) : null}

          <SessionLog
            storyId={story.id}
            initiative={state.initiativeSlug}
            workspace={story.workspace}
            currentAgent={story.status === "merged" ? "" : story.agent}
            theme={theme}
            navigation={navigation}
          />
        </ScrollView>
      </View>
    </View>
  );
}

// Every initiative in the repos Paseo knows, in the layout the plugin creates (see
// server/harness-layout.ts). Opening a phase shows it on the board; "New initiative" and
// "New phase" scaffold the folders so every repo's .harness looks the same.
type Draft = { repo: string; initiative: string; initiativeTitle: string; epicTitle: string; tracker: HarnessTracker };

function HarnessPicker({
  styles,
  theme,
  active,
  onPicked,
  onOpenAgent,
  onCancel,
}: {
  styles: Styles;
  theme: Theme;
  active: { repo: string; epic: string } | null;
  onPicked(next: { repo?: string; epic?: string }): void;
  onOpenAgent: ((agentId: string) => void) | null;
  onCancel(): void;
}) {
  const paseo = usePaseo();
  const list = useRpc(listHarnessInitiatives);
  const create = useRpc(createHarnessEpicRpc);
  const plan = useRpc(planHarnessPhaseRpc);
  const startLoop = useRpc(startInitiativeLoop);
  const stopLoop = useRpc(stopInitiativeLoop);
  const toast = useToast();
  const [repos, setRepos] = useState<HarnessRepo[] | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ title: string; items: MenuEntry[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { projects } = await paseo.projects.list();
        const result = await list({ repos: projects.map((project) => project.projectRootPath) });
        if (!cancelled) setRepos(result.repos);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not list initiatives");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paseo, list, reload]);

  // Start runs the initiative's stories phase by phase in Paseo worktrees; Stop stops new work.
  async function toggleLoop(repo: string, initiative: string, on: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      if (on) {
        const result = await stopLoop({ repo, initiative });
        if (!result.ok) toast.error(result.error ?? "Could not stop the loop.");
        else toast.show("Loop stopped. Running agents keep going; nothing new starts.");
        return;
      }
      const result = await startLoop({ repo, initiative });
      if (!result.ok) {
        toast.error(result.error ?? "Could not start the loop.");
        return;
      }
      const ids = result.started.map((item) => item.story).join(", ");
      toast.show(ids ? `Loop started: planning ${ids}.` : `Loop on. ${result.reason}.`, { variant: "success" });
      if (result.started[0]) onOpenAgent?.(result.started[0].agentId);
    } finally {
      setBusy(false);
      setReload((n) => n + 1);
    }
  }

  async function submit() {
    if (!draft || busy) return;
    if (!draft.repo) {
      toast.error("Pick a repo for the initiative.");
      return;
    }
    setBusy(true);
    try {
      const result = await create(draft);
      if (!result.ok) {
        toast.error(result.error ?? "Could not create the phase.");
        return;
      }
      if (result.warning) toast.error(`Created ${result.epic}, but the architecture session didn't start: ${result.warning}`);
      else toast.show(`Created ${result.epic}. Architecture session started.`, { variant: "success" });
      if (result.epic) onPicked({ repo: draft.repo, epic: result.epic });
      if (result.agentId) onOpenAgent?.(result.agentId);
    } finally {
      setBusy(false);
    }
  }

  // Re-runs (or resumes) a phase's architecture session; the agent picks up the existing files.
  async function planPhase(repo: string, epic: string) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await plan({ repo, epic });
      if (!result.ok) {
        toast.error(result.error ?? "Could not start the architecture session.");
        return;
      }
      toast.show("Architecture session started.", { variant: "success" });
      if (result.agentId) onOpenAgent?.(result.agentId);
    } finally {
      setBusy(false);
    }
  }

  const input = (value: string, placeholder: string, onChange: (text: string) => void) => (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.foregroundMuted}
      autoCorrect={false}
      style={styles.input}
      onSubmitEditing={() => void submit()}
    />
  );

  const form = (repo: string, initiative: string) =>
    draft && draft.repo === repo && draft.initiative === initiative ? (
      <View style={styles.repoRow}>
        {input(draft.epicTitle, "Phase name", (text) => setDraft({ ...draft, epicTitle: text }))}
        <Button label={busy ? "Creating…" : "Create"} primary disabled={busy} styles={styles} onPress={() => void submit()} />
        <Button label="Cancel" styles={styles} onPress={() => setDraft(null)} />
      </View>
    ) : null;

  // New initiative: pick the repo here instead of from a button on every repo.
  const newInitiative =
    draft && !draft.initiative ? (
      <View style={[styles.previewBox, styles.repoForm]}>
        <Text style={styles.sectionLabel}>NEW INITIATIVE</Text>
        <View style={styles.actions}>
          {(repos ?? []).map((repo) => (
            <Button
              key={repo.repo}
              label={draft.repo === repo.repo ? `✓ ${repo.name}` : repo.name}
              primary={draft.repo === repo.repo}
              styles={styles}
              onPress={() => setDraft({ ...draft, repo: repo.repo })}
            />
          ))}
        </View>
        {input(draft.initiativeTitle, "Initiative name", (text) => setDraft({ ...draft, initiativeTitle: text }))}
        {input(draft.epicTitle, "First phase name", (text) => setDraft({ ...draft, epicTitle: text }))}
        <View style={styles.actions}>
          {/* Work initiatives stay local (stories in .harness); personal ones can publish to Jira. */}
          <Button
            label={draft.tracker === "jira" ? "✓ Publish to Jira" : "Publish to Jira"}
            styles={styles}
            onPress={() => setDraft({ ...draft, tracker: draft.tracker === "jira" ? "local" : "jira" })}
          />
          <View style={styles.flex} />
          <Button label="Cancel" styles={styles} onPress={() => setDraft(null)} />
          <Button label={busy ? "Creating…" : "Create"} primary disabled={busy} styles={styles} onPress={() => void submit()} />
        </View>
      </View>
    ) : null;

  return (
    <View style={styles.repoForm}>
      <View style={styles.headRow}>
        <Text style={[styles.panelTitle, styles.flex]} numberOfLines={1}>
          Initiatives
        </Text>
        <Button
          label="New initiative"
          primary
          disabled={!repos?.length}
          styles={styles}
          onPress={() =>
            setDraft({
              repo: repos?.length === 1 ? repos[0].repo : "",
              initiative: "",
              initiativeTitle: "",
              epicTitle: "",
              tracker: "local",
            })
          }
        />
        <IconButton icon="X" label="Close" theme={theme} styles={styles} onPress={onCancel} />
      </View>
      <Text style={styles.hint}>Each repo keeps them in .harness/initiatives. Open a phase to see it on the board.</Text>
      {newInitiative}
      {error ? <Text style={styles.danger}>{error}</Text> : null}
      {!repos && !error ? <Text style={styles.muted}>Looking through your repos…</Text> : null}
      {repos?.length === 0 ? <Text style={styles.muted}>No git repos in Paseo yet. Add one as a project first.</Text> : null}
      {repos?.map((repo) => (
        <View key={repo.repo} style={styles.step}>
          <Text style={styles.stepLabel}>{repo.name.toUpperCase()}</Text>
          {repo.initiatives.length === 0 ? <Text style={styles.hint}>No initiatives yet.</Text> : null}
          {repo.initiatives.map((initiative) => {
            const on = initiative.loop === "on";
            const items: MenuEntry[] = [
              ...(initiative.loop !== "done" && initiative.epics.length > 0
                ? [
                    {
                      label: on ? "Stop loop" : "Start loop",
                      icon: on ? "Square" : "Play",
                      onPress: () => void toggleLoop(repo.repo, initiative.slug, on),
                    },
                  ]
                : []),
              {
                label: "New phase",
                icon: "Plus",
                onPress: () =>
                  setDraft({ repo: repo.repo, initiative: initiative.slug, initiativeTitle: "", epicTitle: "", tracker: initiative.tracker }),
              },
            ];
            return (
              <View key={initiative.slug} style={styles.listGroup}>
                <View style={styles.listRow}>
                  <View style={styles.listRowText}>
                    <View style={styles.listRowTop}>
                      <Text style={[styles.nodeTitle, styles.shrink]} numberOfLines={1}>
                        {initiative.title}
                      </Text>
                      {on ? <Text style={[styles.chip, { color: theme.colors.accent, borderColor: theme.colors.accent }]}>Running</Text> : null}
                      {initiative.loop === "done" ? (
                        <Text style={[styles.chip, { color: theme.colors.statusSuccess, borderColor: theme.colors.statusSuccess }]}>Done</Text>
                      ) : null}
                    </View>
                    <Text style={styles.hint} numberOfLines={1}>
                      {initiative.slug}  ·  {initiative.tracker === "jira" ? "Jira" : "local"}
                    </Text>
                  </View>
                  <IconButton
                    icon="MoreHorizontal"
                    label={`${initiative.title} actions`}
                    theme={theme}
                    styles={styles}
                    onPress={() => setMenu({ title: initiative.title, items })}
                  />
                </View>
                {form(repo.repo, initiative.slug) ? (
                  <View style={[styles.listRowDivider, styles.listRowPad]}>{form(repo.repo, initiative.slug)}</View>
                ) : null}
                {initiative.epics.length === 0 ? (
                  <Text style={[styles.hint, styles.listRowDivider, styles.listRowPad]}>No phases yet.</Text>
                ) : null}
                {initiative.epics.map((epic) => {
                  const current = active?.repo === repo.repo && active.epic === epic.path;
                  return (
                    <Pressable
                      key={epic.path}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${phaseLabel(epic.id)}, ${epic.title}`}
                      disabled={busy}
                      onPress={() => onPicked({ repo: repo.repo, epic: epic.path })}
                      style={[styles.listRow, styles.listRowDivider]}
                    >
                      <View style={styles.listRowText}>
                        <View style={styles.listRowTop}>
                          <Text style={styles.nodeId}>{phaseLabel(epic.id)}</Text>
                          <Text style={[styles.nodeTitle, styles.shrink]} numberOfLines={1}>
                            {epic.title}
                          </Text>
                        </View>
                        <Text style={styles.hint} numberOfLines={1}>
                          {epic.merged}/{epic.stories} merged{current ? "  ·  on the board" : ""}
                        </Text>
                      </View>
                      <IconButton
                        icon="MoreHorizontal"
                        label={`${phaseLabel(epic.id)} actions`}
                        theme={theme}
                        styles={styles}
                        onPress={() =>
                          setMenu({
                            title: `${phaseLabel(epic.id)}: ${epic.title}`,
                            items: [{ label: "Plan architecture", icon: "Network", onPress: () => void planPhase(repo.repo, epic.path) }],
                          })
                        }
                      />
                      <Icon name="ChevronRight" size={16} color={theme.colors.foregroundMuted} />
                    </Pressable>
                  );
                })}
              </View>
            );
          })}
        </View>
      ))}
      <ActionMenu
        title={menu?.title ?? ""}
        open={menu !== null}
        onOpenChange={(open) => !open && setMenu(null)}
        items={menu?.items ?? []}
        theme={theme}
        styles={styles}
      />
    </View>
  );
}

type MenuEntry = { label: string; icon: string; danger?: boolean; onPress(): void } | "separator";

// The ⋯ menu: Paseo's modal, which is a sheet on a phone. Picking an item closes it first.
function ActionMenu({
  title,
  open,
  onOpenChange,
  items,
  theme,
  styles,
}: {
  title: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  items: MenuEntry[];
  theme: Theme;
  styles: Styles;
}) {
  return (
    <Modal title={title} open={open} onOpenChange={onOpenChange}>
      <Modal.Content scrollable={false} contentContainerStyle={{ padding: 0, gap: 0 }}>
        {items.map((item, index) =>
          item === "separator" ? (
            <View key={`sep${index}`} style={styles.menuSeparator} />
          ) : (
            <Pressable
              key={item.label}
              accessibilityRole="menuitem"
              onPress={() => {
                onOpenChange(false);
                item.onPress();
              }}
              style={styles.menuItem}
            >
              <Icon name={item.icon} size={16} color={item.danger ? theme.colors.statusDanger : theme.colors.foreground} />
              <Text style={[styles.menuText, item.danger ? styles.buttonDangerText : null]}>{item.label}</Text>
            </Pressable>
          ),
        )}
      </Modal.Content>
    </Modal>
  );
}

function IconButton({
  icon,
  label,
  theme,
  styles,
  onPress,
}: {
  icon: string;
  label: string;
  theme: Theme;
  styles: Styles;
  onPress(): void;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.iconButton}>
      <Icon name={icon} size={18} color={theme.colors.foreground} />
    </Pressable>
  );
}

function Segmented<Value extends string>({
  value,
  options,
  styles,
  onChange,
}: {
  value: Value;
  options: [Value, string][];
  styles: Styles;
  onChange(value: Value): void;
}) {
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {options.map(([id, label]) => (
        <Pressable
          key={id}
          accessibilityRole="tab"
          accessibilityState={{ selected: value === id }}
          onPress={() => onChange(id)}
          style={[styles.segment, value === id ? styles.segmentOn : null]}
        >
          <Text style={[styles.segmentText, value === id ? styles.segmentTextOn : null]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Button({
  label,
  primary,
  danger,
  disabled,
  styles,
  onPress,
}: {
  label: string;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  styles: Styles;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, primary ? styles.buttonPrimary : null, danger ? styles.buttonDanger : null, disabled ? styles.buttonDisabled : null]}
    >
      <Text style={[styles.buttonText, primary ? styles.buttonPrimaryText : null, danger ? styles.buttonDangerText : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

function createStyles(theme: Theme, compact: boolean) {
  const c = theme.colors;
  return {
    screenFill: { gap: 16, alignSelf: "stretch" as const, width: "100%" as const },
    panel: {
      alignSelf: "stretch" as const,
      width: "100%" as const,
      gap: 12,
      padding: compact ? 14 : 18,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface1,
    },
    panelTitle: { color: c.foreground, fontSize: compact ? 16 : 18, fontWeight: "600" as const },
    folded: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10, paddingVertical: 10 },
    foldedTitle: { color: c.foreground, fontSize: 13, fontWeight: "600" as const },
    head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, flexWrap: "wrap" as const },
    // Title on the left, one primary action and ⋯ on the right; never wraps.
    headRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    headText: { flex: 1, minWidth: 0, gap: 4 },
    titleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    shrink: { flexShrink: 1 },
    chip: {
      fontSize: 11,
      fontWeight: "600" as const,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 999,
      borderWidth: 1,
      overflow: "hidden" as const,
    },
    muted: { color: c.foregroundMuted, fontSize: 12.5 },
    danger: { color: c.statusDanger, fontSize: 12.5 },
    hint: { color: c.foregroundMuted, fontSize: 11.5 },
    bannerText: { color: c.foreground, fontSize: 12.5 },
    sectionLabel: { color: c.foregroundMuted, fontSize: 11, letterSpacing: 0.8, fontWeight: "600" as const },
    flex: { flex: 1 },
    track: {
      flexDirection: "row" as const,
      alignSelf: "stretch" as const,
      height: 4,
      borderRadius: 2,
      overflow: "hidden" as const,
      backgroundColor: c.surface2,
    },
    trackFill: { height: 4 },
    graphScroll: { paddingBottom: 4 },
    // The legend line above the sections.
    legend: { flexDirection: "row" as const, alignItems: "center" as const, flexWrap: "wrap" as const, columnGap: 16, rowGap: 6 },
    legendTitle: { color: c.foreground, fontSize: 12, fontWeight: "600" as const },
    legendItem: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    legendSwatch: { width: 8, height: 8, borderRadius: 2, borderWidth: 1.5 },
    legendSegments: { flexDirection: "row" as const, gap: 2 },
    legendSegment: { width: 6, height: 3 },
    // One initiative: a header row that folds the section, then its body.
    section: { gap: 14 },
    sectionHead: { flexDirection: "row" as const, alignItems: "center" as const, flexWrap: "wrap" as const, columnGap: 14, rowGap: 10 },
    sectionToggle: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10, flexGrow: 1, flexBasis: 220, minWidth: 0 },
    sectionBody: { gap: 14, paddingLeft: compact ? 0 : 26 },
    progress: { alignItems: "flex-end" as const, gap: 6, width: compact ? undefined : 120, flexGrow: compact ? 1 : 0 },
    progressText: { color: c.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums" as const] },
    noteRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10 },
    noteDot: { width: 7, height: 7, borderRadius: 4 },
    noteText: { flex: 1, fontSize: 12.5 },
    emptyBox: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      flexWrap: "wrap" as const,
      gap: 12,
      padding: 22,
      borderWidth: 1,
      borderStyle: "dashed" as const,
      borderColor: c.border,
      borderRadius: 8,
    },
    node: {
      backgroundColor: c.surface0,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 7,
      paddingHorizontal: 10,
      paddingVertical: 9,
      justifyContent: "center" as const,
      gap: 5,
      overflow: "hidden" as const,
    },
    nodeTint: { position: "absolute" as const, top: 0, right: 0, bottom: 0, left: 0, opacity: 0.14 },
    nodeSelected: { borderColor: c.accent, borderWidth: 2 },
    nodeWaiting: { opacity: 0.6 },
    nodeTop: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    nodeId: { color: c.foregroundMuted, fontFamily: "monospace", fontSize: 12, fontWeight: "500" as const },
    nodeTitle: { color: c.foreground, fontSize: 13, fontWeight: "600" as const },
    // A graph node's id and title run smaller than the list's so its rows fit 184×88.
    cardId: { fontSize: 10.5 },
    cardTitle: { fontSize: 12, fontWeight: "400" as const },
    mutedTitle: { color: c.foregroundMuted },
    nodeSub: { fontSize: 10.5 },
    // A node's step bar and $ bar share one grid: glyph, bar, label.
    barRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    barGlyph: { width: 12, textAlign: "center" as const, color: c.foregroundMuted, fontSize: 10 },
    barEnd: { width: 30 },
    segments: { flex: 1, flexDirection: "row" as const, gap: 3 },
    segment4: { flex: 1, height: 4, borderRadius: 2 },
    ctxTrack: { flex: 1, height: 4, borderRadius: 2, backgroundColor: c.surface2 },
    ctxFill: { position: "absolute" as const, left: 0, top: 0, bottom: 0, borderRadius: 2 },
    ctxAct: { position: "absolute" as const, top: -2, bottom: -2, width: 1 },
    ctxLabel: { fontSize: 10, textAlign: "right" as const, fontVariant: ["tabular-nums" as const] },
    badge: {
      marginLeft: "auto" as const,
      fontSize: 10.5,
      fontWeight: "600" as const,
      paddingHorizontal: 7,
      paddingVertical: 1,
      borderRadius: 999,
      borderWidth: 1,
      overflow: "hidden" as const,
    },
    arrowHead: {
      position: "absolute" as const,
      width: 0,
      height: 0,
      borderTopWidth: 5,
      borderBottomWidth: 5,
      borderLeftWidth: 7,
      borderTopColor: "transparent",
      borderBottomColor: "transparent",
    },
    steps: { gap: 14 },
    step: { gap: 6 },
    stepLabel: { color: c.foregroundMuted, fontSize: 10.5, letterSpacing: 0.7, fontWeight: "600" as const },
    repoForm: { gap: 8 },
    repoRow: { flexDirection: "row" as const, gap: 8, alignItems: "center" as const, flexWrap: "wrap" as const },
    input: {
      flex: 1,
      minWidth: 240,
      color: c.foreground,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      backgroundColor: c.surface0,
    },
    button: {
      // 44pt touch targets on a phone.
      minHeight: compact ? 44 : 32,
      justifyContent: "center" as const,
      paddingHorizontal: compact ? 14 : 11,
      paddingVertical: 6,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface0,
    },
    buttonPrimary: { backgroundColor: c.accent, borderColor: c.accent },
    buttonDanger: { borderColor: c.statusDanger },
    buttonDisabled: { opacity: 0.6 },
    buttonText: { color: c.foreground, fontSize: 12.5, fontWeight: "500" as const },
    buttonPrimaryText: { color: c.accentForeground },
    buttonDangerText: { color: c.statusDanger },
    overlay: {
      // Above the dashboard header, which sits at zIndex 10 so its menus clear the tab body.
      zIndex: 20,
      position: "absolute" as const,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      flexDirection: "row" as const,
      justifyContent: "flex-end" as const,
    },
    backdrop: {
      position: "absolute" as const,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: "rgba(0, 0, 0, 0.32)",
    },
    drawer: {
      width: compact ? ("100%" as const) : 440,
      maxWidth: "100%" as const,
      height: "100%" as const,
      backgroundColor: c.surface0,
      borderLeftWidth: compact ? 0 : 1,
      borderLeftColor: c.border,
      paddingTop: compact ? 16 : 20,
    },
    drawerHead: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      paddingHorizontal: 18,
      paddingBottom: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    drawerBody: { padding: 18, gap: 14 },
    drawerTitle: { color: c.foreground, fontSize: 16, fontWeight: "600" as const },
    reason: {
      color: c.statusDanger,
      fontSize: 12.5,
      borderWidth: 1,
      borderColor: c.statusDanger,
      borderRadius: 8,
      padding: 8,
    },
    actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
    previewBox: { gap: 8, padding: 12, borderRadius: 10, backgroundColor: c.surface1 },
    iconButton: {
      width: compact ? 44 : 32,
      height: compact ? 44 : 32,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      borderRadius: 8,
    },
    // Inset grouped list: one bordered block per group, hairline dividers between rows.
    listGroup: { borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface0, overflow: "hidden" as const },
    listRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 10,
      minHeight: compact ? 56 : 48,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    listRowDivider: { borderTopWidth: 1, borderTopColor: c.border },
    listRowPad: { padding: 12 },
    listRowText: { flex: 1, minWidth: 0, gap: 2 },
    listRowTop: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    groupToggle: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4, minHeight: 32 },
    segmented: {
      flexDirection: "row" as const,
      padding: 3,
      gap: 3,
      borderRadius: 10,
      backgroundColor: c.surface2,
    },
    segment: { flex: 1, minHeight: compact ? 36 : 30, alignItems: "center" as const, justifyContent: "center" as const, borderRadius: 8 },
    segmentOn: { backgroundColor: c.surface0 },
    segmentText: { color: c.foregroundMuted, fontSize: 12.5, fontWeight: "500" as const },
    segmentTextOn: { color: c.foreground },
    menuItem: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 12,
      minHeight: 48,
      paddingHorizontal: 20,
    },
    menuText: { color: c.foreground, fontSize: 14 },
    menuSeparator: { height: 1, backgroundColor: c.border, marginVertical: 4 },
    modalActions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, gap: 8 },
    related: { gap: 6 },
  };
}
