import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { harnessSettings } from "../shared/settings";
import { startInitiativeLoop, stopInitiativeLoop } from "../shared/initiative-loop";
import { SessionLog } from "./session-log";
import { boardKey, pollDelay } from "./epic-board-model";

// Every initiative's current phase (see server/harness-layout.ts) as its dependency graph: one
// card per story, arrows from a dependency to the stories that need it. Initiatives are occasional
// work; day-to-day epics come from Jira. Each graph starts open and folds to one line with Hide.

type Theme = PluginSurfaceProps["theme"];
type Navigation = PluginSurfaceProps["navigation"];
type Styles = ReturnType<typeof createStyles>;

const W = 230;
const H = 66;
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

// What a story needs from you, as a short badge on its card.
function badgeOf(story: EpicStory, theme: Theme): [string, string] | null {
  if (story.status === "awaiting-approval") return ["Your turn", theme.colors.statusWarning];
  if (story.status === "pr-open" && story.ci === "failing") return ["CI failing", theme.colors.statusDanger];
  if (story.status === "pr-open") return ["Merge", theme.colors.statusSuccess];
  if (story.status === "blocked") return ["Blocked", theme.colors.statusDanger];
  if (story.ready) return ["Ready", theme.colors.accent];
  return null;
}

function subline(story: EpicStory) {
  if (story.status === "todo" && story.blockedBy) return `blocked by ${story.blockedBy}`;
  if (story.status === "todo" && !story.ready && story.dependsOn.length) {
    return `waiting on ${story.dependsOn.join(", ")}`;
  }
  return [
    labelOf(story.status),
    story.pr ? `#${story.pr}` : "",
    story.status === "pr-open" && story.ci ? `CI ${story.ci}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// A story waits on you when its plan needs approval, it is blocked, or its PR is green and ready to merge.
const needsYou = (story: EpicStory) =>
  story.status === "blocked" || story.status === "awaiting-approval" || (story.status === "pr-open" && story.ci === "green");

function iconOf(story: EpicStory) {
  if (needsYou(story)) return "AlertCircle";
  if (story.status === "merged") return "CheckCircle";
  if (story.status === "todo") return "Circle";
  return "Loader";
}

// One line under a story's title in the phone list: what it is doing, or what it is waiting on.
function contextOf(story: EpicStory) {
  if (story.status === "awaiting-approval") return "Plan ready for your approval";
  if (story.status === "blocked") return story.blockedReason || "Blocked";
  if (story.status === "pr-open" && story.ci === "green") return `PR #${story.pr} ready to merge`;
  if (story.status === "todo" && story.ready) return "Ready to start";
  return subline(story);
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
      const done = byId.get(dep)?.status === "merged";
      // Red when either end failed: the story it feeds is blocked, or the dependency holding it up is.
      const failed = story.status === "blocked" || byId.get(dep)?.status === "blocked";
      const color = hot
        ? theme.colors.accent
        : failed
          ? theme.colors.statusDanger
          : done
            ? theme.colors.statusSuccess
            : theme.colors.foregroundMuted;
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

// Returns one panel per initiative (for the dashboard's scroll view) and the story drawer (for the
// screen root, so it covers the whole surface like the prod pulse drawer).
export function useEpicBoard({
  theme,
  compact,
  navigation,
}: {
  theme: Theme;
  compact: boolean;
  navigation: Navigation;
}): { panels: ReactNode; drawer: ReactNode } {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const paseo = usePaseo();
  const loadBoards = useRpc(getEpicBoards);
  const settings = useSettings(harnessSettings);
  const toast = useToast();
  const [boards, setBoards] = useState<EpicBoard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ board: string; story: string } | null>(null);
  const [editing, setEditing] = useState(false);

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

  // Picking or creating a phase shows it on its initiative's board.
  async function pointAt(next: Partial<{ repo: string; epic: string }>) {
    if (settings.status !== "ready") return;
    const saved = await settings.save({ ...settings.values, ...next }, settings.revision);
    if (saved) setEditing(false);
    else toast.error(settings.saveError ?? "Could not save the initiative repo.");
    void refresh();
  }

  if (editing) {
    return {
      drawer: null,
      panels: (
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
      ),
    };
  }

  if (!boards?.length) {
    return {
      drawer: null,
      panels: (
        <View style={[styles.panel, styles.folded]}>
          <Text style={styles.foldedTitle}>Initiatives</Text>
          <Text style={[error ? styles.danger : styles.muted, styles.flex]} numberOfLines={1}>
            {error ?? (boards ? "not set up" : "Loading…")}
          </Text>
          <Button label="Initiatives" styles={styles} onPress={() => setEditing(true)} />
        </View>
      ),
    };
  }

  const open = selected ? boards.find((board) => boardKey(board) === selected.board) : undefined;
  const story = open?.state?.stories.find((item) => item.id === selected?.story) ?? null;

  const panels = (
    <View style={styles.screenFill}>
      {error ? (
        <Text style={styles.danger} numberOfLines={2}>
          Couldn't refresh the initiatives, showing the last read: {error}
        </Text>
      ) : null}
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
            onSelect={(id) => setSelected(id ? { board: key, story: id } : null)}
            onPicker={() => setEditing(true)}
            onChanged={() => void refresh()}
          />
        );
      })}
    </View>
  );

  const drawer =
    story && open?.state ? (
      <StoryDrawer
        story={story}
        state={open.state}
        theme={theme}
        styles={styles}
        onClose={() => setSelected(null)}
        onSelect={(id) => setSelected({ board: boardKey(open), story: id })}
        navigation={navigation}
      />
    ) : null;

  return { panels, drawer };
}

// One initiative's current phase as its dependency graph (or grouped list when compact), with its
// loop and plan actions. Each panel folds on its own with Hide.
function InitiativePanel({
  board,
  theme,
  styles,
  compact,
  navigation,
  selected,
  onSelect,
  onPicker,
  onChanged,
}: {
  board: EpicBoard;
  theme: Theme;
  styles: Styles;
  compact: boolean;
  navigation: Navigation;
  selected: string | null;
  onSelect(id: string | null): void;
  onPicker(): void;
  onChanged(): void;
}) {
  const removeInitiative = useRpc(deleteEpicInitiative);
  const openPlan = useRpc(openPhasePlanRpc);
  const paseo = usePaseo();
  const refreshPlan = useRpc(refreshPhasePlanRpc);
  const startLoop = useRpc(startInitiativeLoop);
  const stopLoop = useRpc(stopInitiativeLoop);
  const toast = useToast();
  const { repo, state, error } = board;
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [shown, setShown] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [listView, setListView] = useState<"status" | "step">("status");
  const [mergedOpen, setMergedOpen] = useState(false);

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
        <Text style={error ? styles.danger : styles.muted}>{error ?? "Loading the initiative…"}</Text>
      </View>
    );
  }

  const stories = state.stories;
  const merged = stories.filter((story) => story.status === "merged").length;
  const left = stories.length - merged;
  const graph = edgesFor(stories, selected, theme);
  const phase = [state.epic.id ? phaseLabel(state.epic.id) : "", state.epic.title].filter(Boolean).join(": ");
  const working = stories.filter((item) => ["planning", "awaiting-approval", "implementing", "reviewing", "pr-open"].includes(item.status)).length;
  const initiative = state.initiative || "Initiative";

  if (!shown) {
    return (
      <View style={[styles.panel, styles.folded]}>
        <Text style={styles.foldedTitle}>Initiative</Text>
        <Text style={[styles.muted, styles.flex]} numberOfLines={1}>
          {initiative}  ·  {phase}  ·  {merged}/{stories.length} merged{state.loop === "on" ? "  ·  ▶ running" : ""}
        </Text>
        <Button label="Show" styles={styles} onPress={() => setShown(true)} />
      </View>
    );
  }

  const card = (item: EpicStory, absolute?: { x: number; y: number }) => {
    const tone = toneOf(item.status, theme);
    const badge = badgeOf(item, theme);
    const isSelected = item.id === selected;
    const waiting = item.status === "todo" && !item.ready;
    return (
      <Pressable
        key={item.id}
        accessibilityRole="button"
        accessibilityState={{ selected: isSelected }}
        accessibilityLabel={`${item.id}, ${item.title}, ${subline(item)}${badge ? `, ${badge[0]}` : ""}`}
        onPress={() => onSelect(isSelected ? null : item.id)}
        style={[
          styles.node,
          { borderLeftColor: tone },
          absolute ? { position: "absolute", left: absolute.x, top: absolute.y, width: W, height: H } : styles.nodeListed,
          item.id === state.next.story ? { borderColor: tone } : null,
          isSelected ? styles.nodeSelected : null,
          waiting ? styles.nodeWaiting : null,
        ]}
      >
        <View style={styles.nodeTop}>
          <Text style={styles.nodeId}>{item.id}</Text>
          {badge ? (
            <Text style={[styles.badge, { color: badge[1], borderColor: badge[1] }]}>{badge[0]}</Text>
          ) : null}
        </View>
        <Text style={styles.nodeTitle} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={[styles.nodeSub, { color: tone }]} numberOfLines={1}>
          {subline(item)}
        </Text>
      </Pressable>
    );
  };

  const planning = Boolean(state.plan && state.plan.status !== "agreed");
  const chip: [string, string] | null =
    state.loop === "on"
      ? ["Running", theme.colors.accent]
      : state.loop === "done"
        ? ["Done", theme.colors.statusSuccess]
        : planning
          ? ["Planning", theme.colors.statusWarning]
          : state.plan?.status === "agreed" && left > 0
            ? ["Ready", theme.colors.accent]
            : null;
  const canStart = state.loop === "off" && left > 0;
  // One obvious next step; everything else lives in the ⋯ menu.
  const primary =
    state.loop === "on"
      ? { label: busy === "loop-stop:" ? "Stopping…" : "Stop", primary: false, onPress: () => void loopAction("stop") }
      : canStart && !planning
        ? { label: busy === "loop-start:" ? "Starting…" : "Start", primary: true, onPress: () => void loopAction("start") }
        : state.plan
          ? { label: busy === "plan-open:" ? "Opening…" : "View plan", primary: true, plan: true, onPress: () => void planAction("open") }
          : null;
  const menu: MenuEntry[] = [
    ...(canStart && planning ? [{ label: "Start before planning is done", icon: "Play", onPress: () => void loopAction("start") }] : []),
    ...(state.plan && !(primary && "plan" in primary) ? [{ label: "View plan", icon: "FileText", onPress: () => void planAction("open") }] : []),
    ...(state.plan?.jira ? [{ label: "Refresh from Jira", icon: "RefreshCw", onPress: () => void planAction("jira") }] : []),
    { label: "Initiatives and phases", icon: "FolderOpen", onPress: onPicker },
    { label: "Hide", icon: "EyeOff", onPress: () => setShown(false) },
    "separator",
    { label: "Delete initiative", icon: "Trash2", danger: true, onPress: () => setConfirmDelete(true) },
  ];

  const row = (item: EpicStory, index: number) => {
    const tone = toneOf(item.status, theme);
    return (
      <Pressable
        key={item.id}
        accessibilityRole="button"
        accessibilityLabel={`${item.id}, ${item.title}, ${contextOf(item)}`}
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
            {contextOf(item)}
          </Text>
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
      <View style={styles.panel}>
        <View style={styles.headRow}>
          <View style={styles.headText}>
            <View style={styles.titleRow}>
              <Text style={[styles.panelTitle, styles.shrink]} numberOfLines={1}>
                {initiative}
              </Text>
              {chip ? <Text style={[styles.chip, { color: chip[1], borderColor: chip[1] }]}>{chip[0]}</Text> : null}
            </View>
            <Text style={styles.muted} numberOfLines={2}>
              {phase ? `${phase}  ·  ` : ""}
              {state.tracker === "jira" ? "Jira" : "local"}  ·  {merged}/{stories.length} merged
              {state.loop === "off" ? `  ·  Next: ${state.next.reason}` : ""}
            </Text>
          </View>
          {primary ? (
            <Button label={primary.label} primary={primary.primary} disabled={busy !== null} styles={styles} onPress={primary.onPress} />
          ) : null}
          <IconButton icon="MoreHorizontal" label="More actions" theme={theme} styles={styles} onPress={() => setMenuOpen(true)} />
        </View>
        <View style={styles.track}>
          <View style={[styles.trackFill, { flex: merged, backgroundColor: theme.colors.statusSuccess }]} />
          <View style={{ flex: Math.max(0, left) }} />
        </View>
        {error ? <Text style={styles.danger}>{error}</Text> : null}
        {state.loop === "on" ? (
          <View style={styles.previewBox}>
            <Text style={styles.bannerText}>
              Running {phase || "this phase"}: {working} in progress · {merged} merged · {left - working} waiting. Stop only keeps
              new work from starting.
            </Text>
          </View>
        ) : state.loop === "off" && state.plan?.status === "agreed" && left > 0 ? (
          <View style={styles.previewBox}>
            <Text style={styles.bannerText}>
              Planning done. Start runs {initiative} phase by phase: each ready story gets its own worktree, and the rest follow
              as their dependencies merge.
            </Text>
          </View>
        ) : planning ? (
          <Text style={styles.hint}>Planning in progress. Say "lock" in the architecture session when the plan is ready.</Text>
        ) : null}
        {state.plan?.warnings.length ? (
          <Text style={styles.hint} numberOfLines={2}>
            Plan gaps: {state.plan.warnings.join(" · ")}
          </Text>
        ) : null}

        {compact ? (
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
            <Text style={styles.hint}>Arrows go from a dependency to the stories that need it. Tap a story for its details.</Text>
          </>
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

function StoryDrawer({
  story,
  state,
  theme,
  styles,
  onClose,
  onSelect,
  navigation,
}: {
  story: EpicStory;
  state: EpicBoardState;
  theme: Theme;
  styles: Styles;
  onClose(): void;
  onSelect(id: string): void;
  navigation: Navigation;
}) {
  const tone = toneOf(story.status, theme);
  const neededBy = state.stories.filter((item) => item.dependsOn.includes(story.id));
  const prUrl = story.pr && state.repoUrl ? `${state.repoUrl}/pull/${story.pr}` : "";

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
          {prUrl || (navigation && (story.agent || story.workspace)) ? (
            <View style={styles.actions}>
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
    track: { flexDirection: "row" as const, height: 4, borderRadius: 2, overflow: "hidden" as const, backgroundColor: c.surface2 },
    trackFill: { height: 4 },
    graphScroll: { paddingBottom: 4 },
    node: {
      backgroundColor: c.surface0,
      borderWidth: 1,
      borderColor: c.border,
      borderLeftWidth: 3,
      borderRadius: 10,
      paddingHorizontal: 12,
      justifyContent: "center" as const,
      gap: 1,
    },
    nodeListed: { paddingVertical: 10 },
    nodeSelected: { borderColor: c.accent, borderWidth: 2, borderLeftWidth: 3 },
    nodeWaiting: { opacity: 0.6 },
    nodeTop: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    nodeId: { color: c.foregroundMuted, fontFamily: "monospace", fontSize: 12, fontWeight: "500" as const },
    nodeTitle: { color: c.foreground, fontSize: 13, fontWeight: "600" as const },
    nodeSub: { fontSize: 11.5 },
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
