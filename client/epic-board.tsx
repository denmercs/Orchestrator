import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { openExternalUrl, usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import {
  createHarnessEpicRpc,
  deleteEpicInitiative,
  getEpicBoard,
  listHarnessInitiatives,
  runEpicAction,
  type EpicAction,
  type EpicBoardState,
  type EpicStory,
  type HarnessRepo,
} from "../shared/orchestration";
import { harnessSettings } from "../shared/settings";

// The active harness epic (see server/harness-layout.ts) as its dependency graph: one card per story,
// arrows from a dependency to the stories that need it. Harness epics are occasional work (a
// hackathon, an initiative); day-to-day epics come from Jira, so the graph stays folded to one
// line unless its loop is running or you open it.

type Theme = PluginSurfaceProps["theme"];
type Navigation = PluginSurfaceProps["navigation"];
type Styles = ReturnType<typeof createStyles>;

const POLL_MS = 3000;
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
  if (story.session?.held) return ["Your turn", theme.colors.statusWarning];
  if (story.status === "awaiting-approval") return ["Approve story plan", theme.colors.statusWarning];
  if (story.status === "pr-open") return ["Merge", theme.colors.statusSuccess];
  if (story.status === "blocked") return ["Blocked", theme.colors.statusDanger];
  if (story.ready && !story.loopPid) return ["Ready", theme.colors.accent];
  return null;
}

const working = (story: EpicStory) =>
  ["planning", "implementing", "reviewing"].includes(story.status) &&
  Boolean(story.loopPid || story.session?.live);

function subline(story: EpicStory) {
  if (story.status === "todo" && story.blockedBy) return `blocked by ${story.blockedBy}`;
  if (story.status === "todo" && !story.ready && story.dependsOn.length) {
    return `waiting on ${story.dependsOn.join(", ")}`;
  }
  return [
    labelOf(story.status),
    story.cycles ? `${story.cycles.done}/${story.cycles.total}` : "",
    story.pr ? `#${story.pr}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
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

// Milestones only: what moved the epic forward or needs a person.
const MILESTONE =
  /: (PR #\d+ merged|PR opened|plan ready for review|plan approved|blocked —|filed|started on|started \(dashboard\)|started \(parallel|stopped \(dashboard\)|retried)/;
const TOAST = /merged|plan ready|blocked —|filed/;
const milestoneText = (text: string) =>
  text
    .replace(/ — [^ ]+\.md\. Approve with --approve \S+$/, "")
    .replace(/^(\S+): PR opened (\S+\/pull\/(\d+))$/, "$1: PR #$3 opened")
    // Each story has its own plan; keep it apart from the harness plan this panel shows.
    .replace(/\bplan (ready|approved)/, "story plan $1");

// Returns the board's panels (for the dashboard's scroll view) and the story drawer (for the
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
  const loadBoard = useRpc(getEpicBoard);
  const act = useRpc(runEpicAction);
  const removeInitiative = useRpc(deleteEpicInitiative);
  const settings = useSettings(harnessSettings);
  const toast = useToast();
  const [state, setState] = useState<EpicBoardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [shown, setShown] = useState(false);
  const seenProgress = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await loadBoard({});
      setRepo(result.repo);
      setError(result.error);
      setState(result.state);
      if (result.state) {
        const progress = result.state.progress;
        if (seenProgress.current !== null) {
          for (const item of progress) {
            if (item.at > seenProgress.current && MILESTONE.test(item.text) && TOAST.test(item.text)) {
              const text = milestoneText(item.text);
              toast.show(text, { variant: /merged/.test(text) ? "success" : /blocked/.test(text) ? "warning" : "info" });
            }
          }
        }
        seenProgress.current = progress.length ? progress[progress.length - 1].at : "";
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to read the harness plan");
    }
  }, [loadBoard, toast]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // Settings changes (a new repo) reset what was already toasted.
  const settingsKey = settings.status === "ready" ? `${settings.values.repo}\n${settings.values.epic}\n${settings.values.runner}` : "";
  useEffect(() => {
    seenProgress.current = null;
    setSelected(null);
    void refresh();
  }, [settingsKey, refresh]);

  useEffect(() => {
    if (!confirmStop && !confirmDelete) return;
    const timer = setTimeout(() => {
      setConfirmStop(false);
      setConfirmDelete(false);
    }, 4000);
    return () => clearTimeout(timer);
  }, [confirmStop, confirmDelete]);

  async function run(action: EpicAction, id?: string, path?: string) {
    const key = `${action}:${id ?? ""}`;
    if (busy) return;
    setBusy(key);
    try {
      const result = await act({ action, id });
      if (!result.ok) {
        toast.error(`${id ? `${id}: ` : ""}${result.error ?? "failed"}`);
      } else if (action === "preview" && result.url) {
        void openExternalUrl(result.url + (path ?? "/"));
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Action failed");
    } finally {
      setBusy(null);
      void refresh();
    }
  }

  // Deleting removes the initiative's files for good (.harness is not in git), then clears the
  // repo so the panel folds back to "not set up".
  async function deleteInitiative() {
    if (busy || settings.status !== "ready") return;
    setBusy("delete:");
    try {
      const result = await removeInitiative({});
      if (!result.ok) {
        toast.error(result.error ?? "Could not delete the initiative.");
        return;
      }
      toast.show(`Deleted ${result.deleted}`, { variant: "success" });
      setShown(false);
      if (!(await settings.save({ ...settings.values, repo: "", epic: "" }, settings.revision))) {
        toast.error(settings.saveError ?? "Deleted, but could not clear the harness plan repo.");
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not delete the initiative.");
    } finally {
      setBusy(null);
      void refresh();
    }
  }

  // Picking or creating an epic (or setting the runner) points the board at it.
  async function pointAt(next: Partial<{ repo: string; epic: string; runner: string }>) {
    if (settings.status !== "ready") return;
    const saved = await settings.save({ ...settings.values, ...next }, settings.revision);
    if (saved) setEditing(false);
    else toast.error(settings.saveError ?? "Could not save the harness plan repo.");
    void refresh();
  }

  function openSession(story: EpicStory) {
    if (story.session && navigation) navigation.openAgent({ agentId: story.session.id });
  }

  const repoForm = (
    <HarnessPicker
      styles={styles}
      theme={theme}
      active={settings.status === "ready" ? settings.values : null}
      onPicked={(next) => void pointAt(next)}
      onCancel={() => setEditing(false)}
    />
  );

  if (!repo && !editing) {
    return {
      drawer: null,
      panels: (
        <View style={[styles.panel, styles.folded]}>
          <Text style={styles.foldedTitle}>Harness plan</Text>
          <Text style={[styles.muted, styles.flex]}>not set up</Text>
          <Button label="Initiatives" styles={styles} onPress={() => setEditing(true)} />
        </View>
      ),
    };
  }

  if (!repo || editing) {
    return {
      drawer: null,
      panels: (
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Harness plan</Text>
          {repoForm}
        </View>
      ),
    };
  }

  if (!state) {
    return {
      drawer: null,
      panels: (
      <View style={styles.panel}>
        <View style={styles.head}>
          <Text style={styles.panelTitle}>Harness plan</Text>
          <Button
            label="Initiatives"
            styles={styles}
            onPress={() => setEditing(true)}
          />
        </View>
        <Text style={error ? styles.danger : styles.muted}>{error ?? "Loading the harness plan…"}</Text>
      </View>
      ),
    };
  }

  const stories = state.stories;
  const merged = stories.filter((story) => story.status === "merged").length;
  const left = stories.length - merged;
  const graph = edgesFor(stories, selected, theme);
  const story = selected ? stories.find((item) => item.id === selected) ?? null : null;
  const updates = state.progress.filter((item) => MILESTONE.test(item.text)).slice(-8).reverse();
  const running = state.loop.pid !== null;
  const active =
    running || stories.some((item) => item.loopPid !== null || item.session?.live || item.session?.held);
  const epicLabel = `${state.epic.id ? `${state.epic.id} · ` : ""}${state.epic.title || "Epic"}`;

  if (!active && !shown) {
    return {
      drawer: null,
      panels: (
        <View style={[styles.panel, styles.folded]}>
          <Text style={styles.foldedTitle}>Harness plan</Text>
          <Text style={[styles.muted, styles.flex]} numberOfLines={1}>
            {epicLabel}  ·  ○ stopped  ·  {merged}/{stories.length} merged
          </Text>
          <Button label="Show" styles={styles} onPress={() => setShown(true)} />
        </View>
      ),
    };
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
        onPress={() => setSelected(isSelected ? null : item.id)}
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
          {working(item) ? <View style={[styles.liveDot, { backgroundColor: tone }]} /> : null}
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

  const panels = (
    <View style={styles.screenFill}>
      <View style={styles.panel}>
        <View style={styles.head}>
          <View style={styles.headText}>
            <Text style={styles.panelTitle} numberOfLines={1}>
              {epicLabel}
            </Text>
            <Text style={styles.muted} numberOfLines={2}>
              <Text style={{ color: running ? theme.colors.statusSuccess : theme.colors.foregroundMuted }}>
                {running ? `● Plan running · pid ${state.loop.pid}` : "○ Plan stopped"}
              </Text>
              {"  ·  "}
              {merged}/{stories.length} merged{"  ·  "}Next: {state.next.reason}
            </Text>
          </View>
          <View style={styles.headActions}>
            {running ? (
              <Button
                label={confirmStop ? "Tap again to stop" : "Stop plan"}
                danger={confirmStop}
                disabled={busy !== null}
                styles={styles}
                onPress={() => {
                  if (!confirmStop) {
                    setConfirmStop(true);
                    return;
                  }
                  setConfirmStop(false);
                  void run("loop-stop");
                }}
              />
            ) : state.runner && left > 0 ? (
              <Button
                label={busy === "loop-start:" ? "Starting…" : "Run plan"}
                primary
                disabled={busy !== null}
                styles={styles}
                onPress={() => void run("loop-start")}
              />
            ) : null}
            {!active ? <Button label="Hide" styles={styles} onPress={() => setShown(false)} /> : null}
            {!active ? (
              <Button
                label={busy === "delete:" ? "Deleting…" : confirmDelete ? "Tap again to delete" : "Delete initiative"}
                danger={confirmDelete}
                disabled={busy !== null}
                styles={styles}
                onPress={() => {
                  if (!confirmDelete) {
                    setConfirmDelete(true);
                    return;
                  }
                  setConfirmDelete(false);
                  void deleteInitiative();
                }}
              />
            ) : null}
            <Button
              label="Initiatives"
              styles={styles}
              onPress={() => setEditing(true)}
            />
          </View>
        </View>
        <View style={styles.track}>
          <View style={[styles.trackFill, { flex: merged, backgroundColor: theme.colors.statusSuccess }]} />
          <View style={{ flex: Math.max(0, left) }} />
        </View>
        {error ? <Text style={styles.danger}>{error}</Text> : null}

        {compact ? (
          <View style={styles.steps}>
            {graph.cols.map((col, ci) => (
              <View key={ci} style={styles.step}>
                <Text style={styles.stepLabel}>
                  {ci === 0 ? "STEP 1 · NO DEPENDENCIES" : `STEP ${ci + 1} · AFTER STEP ${ci}`}
                </Text>
                {col.map((item) => card(item))}
              </View>
            ))}
          </View>
        ) : (
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
        )}
        <Text style={styles.hint}>
          Arrows go from a dependency to the stories that need it. Tap a story for its actions.
        </Text>
      </View>

      <View style={styles.panel}>
        <Text style={styles.sectionLabel}>PLAN UPDATES</Text>
        {updates.length === 0 ? (
          <Text style={styles.muted}>No milestones yet. Run the plan to begin.</Text>
        ) : (
          updates.map((item) => {
            const [who, ...rest] = milestoneText(item.text).split(": ");
            const when = new Date(item.at);
            const today = when.toDateString() === new Date().toDateString();
            const tone = /merged/.test(item.text)
              ? theme.colors.statusSuccess
              : /blocked/.test(item.text)
                ? theme.colors.statusDanger
                : /plan ready|filed/.test(item.text)
                  ? theme.colors.statusWarning
                  : theme.colors.foregroundMuted;
            return (
              <View key={item.at + item.text} style={styles.update}>
                <Text style={styles.updateTime}>
                  {today
                    ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                    : when.toLocaleDateString([], { month: "short", day: "numeric" })}
                </Text>
                <Text style={[styles.updateWho, { color: tone }]}>{who}</Text>
                <Text style={styles.updateText}>{rest.join(": ")}</Text>
              </View>
            );
          })
        )}
      </View>
    </View>
  );

  const drawer = story ? (
        <StoryDrawer
          story={story}
          state={state}
          theme={theme}
          styles={styles}
          busy={busy}
          canOpenSession={Boolean(navigation)}
          onClose={() => setSelected(null)}
          onSelect={setSelected}
          onRun={(action, path) => void run(action, story.id, path)}
          onOpenSession={() => openSession(story)}
        />
  ) : null;

  return { panels, drawer };
}

function StoryDrawer({
  story,
  state,
  theme,
  styles,
  busy,
  canOpenSession,
  onClose,
  onSelect,
  onRun,
  onOpenSession,
}: {
  story: EpicStory;
  state: EpicBoardState;
  theme: Theme;
  styles: Styles;
  busy: string | null;
  canOpenSession: boolean;
  onClose(): void;
  onSelect(id: string): void;
  onRun(action: EpicAction, path?: string): void;
  onOpenSession(): void;
}) {
  const tone = toneOf(story.status, theme);
  const neededBy = state.stories.filter((item) => item.dependsOn.includes(story.id));
  const history = state.progress
    .filter((item) => item.text.startsWith(`${story.id}:`))
    .slice(-12)
    .reverse();
  const pending = (action: EpicAction) => busy === `${action}:${story.id}`;
  const meta = [
    story.cycles ? `cycle ${story.cycles.done}/${story.cycles.total}` : "",
    story.attempts ? `attempt ${story.attempts + 1}` : "",
    story.session?.held ? `${story.session.phase} held for you` : story.session?.live ? `${story.session.phase} session live` : "",
  ].filter(Boolean);
  const showPreview = state.previewEnabled && (story.status === "reviewing" || story.status === "pr-open");
  const routes = story.preview.routes.length ? story.preview.routes : [{ path: "/", check: story.preview.note }];
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
          {meta.length ? <Text style={styles.muted}>{meta.join(" · ")}</Text> : null}
          {story.cycles ? (
            <View style={styles.track}>
              <View style={[styles.trackFill, { flex: story.cycles.done, backgroundColor: tone }]} />
              <View style={{ flex: Math.max(0, story.cycles.total - story.cycles.done) }} />
            </View>
          ) : null}
          {story.status === "blocked" && story.blockedReason ? (
            <Text style={styles.reason}>{story.blockedReason}</Text>
          ) : null}
          {story.status === "awaiting-approval" && story.planFile ? (
            <Text style={styles.muted}>Plan: {story.planFile}</Text>
          ) : null}

          <View style={styles.actions}>
            {story.session && canOpenSession ? (
              <Button
                label={story.status === "awaiting-approval" ? "Ask the planner" : "Open session"}
                styles={styles}
                onPress={onOpenSession}
              />
            ) : null}
            {story.session?.held ? (
              <Button label={pending("release") ? "Releasing…" : "Release"} primary styles={styles} onPress={() => onRun("release")} />
            ) : null}
            {story.status === "awaiting-approval" && story.planFile ? (
              <Button label={pending("approve") ? "Approving…" : "Approve story plan"} primary styles={styles} onPress={() => onRun("approve")} />
            ) : null}
            {state.runner && story.ready && !story.loopPid ? (
              <Button label={pending("start") ? "Starting…" : "Start planning"} primary styles={styles} onPress={() => onRun("start")} />
            ) : null}
            {story.retryAt && !story.loopPid ? (
              <Button
                label={pending("retry") ? "Retrying…" : `Retry → ${labelOf(story.retryAt).toLowerCase()}`}
                danger
                styles={styles}
                onPress={() => onRun("retry")}
              />
            ) : null}
            {prUrl ? <Button label={`Open PR #${story.pr}`} styles={styles} onPress={() => void openExternalUrl(prUrl)} /> : null}
          </View>

          {showPreview ? (
            <View style={styles.previewBox}>
              <Text style={styles.sectionLabel}>WHAT TO CHECK</Text>
              {routes.map((route) => (
                <Pressable
                  key={route.path}
                  disabled={!story.preview.url}
                  onPress={() => story.preview.url && void openExternalUrl(story.preview.url + route.path)}
                >
                  <Text style={story.preview.url ? styles.link : styles.mono}>{route.path}</Text>
                  {route.check ? <Text style={styles.muted}>{route.check}</Text> : null}
                </Pressable>
              ))}
              <View style={styles.actions}>
                <Button
                  label={pending("preview") ? "Starting dev server…" : story.preview.url ? "Open preview" : "Preview"}
                  primary
                  styles={styles}
                  onPress={() => onRun("preview", routes[0]?.path)}
                />
                {story.preview.url ? <Button label="Stop" styles={styles} onPress={() => onRun("preview-stop")} /> : null}
              </View>
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

          <View style={styles.related}>
            <Text style={styles.sectionLabel}>HISTORY</Text>
            {history.length === 0 ? <Text style={styles.muted}>Nothing yet.</Text> : null}
            {history.map((item) => (
              <View key={item.at + item.text} style={styles.update}>
                <Text style={styles.updateTime}>
                  {new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </Text>
                <Text style={styles.updateText}>{item.text.slice(story.id.length + 2)}</Text>
              </View>
            ))}
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

// Every initiative in the repos Paseo knows, in the layout the plugin creates (see
// server/harness-layout.ts). Opening an epic shows it on the board; "New initiative" and
// "New phase" scaffold the folders (a phase is an epic folder) so every repo's .harness looks the same.
type Draft = { repo: string; initiative: string; initiativeTitle: string; epicTitle: string };

function HarnessPicker({
  styles,
  theme,
  active,
  onPicked,
  onCancel,
}: {
  styles: Styles;
  theme: Theme;
  active: { repo: string; epic: string; runner: string } | null;
  onPicked(next: { repo?: string; epic?: string; runner?: string }): void;
  onCancel(): void;
}) {
  const paseo = usePaseo();
  const list = useRpc(listHarnessInitiatives);
  const create = useRpc(createHarnessEpicRpc);
  const toast = useToast();
  const [repos, setRepos] = useState<HarnessRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [runner, setRunner] = useState(active?.runner ?? "");

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
  }, [paseo, list]);

  async function submit() {
    if (!draft || busy) return;
    setBusy(true);
    try {
      const result = await create(draft);
      if (!result.ok) {
        toast.error(result.error ?? "Could not create the phase.");
        return;
      }
      toast.show(`Created ${result.epic}`, { variant: "success" });
      if (result.epic) onPicked({ repo: draft.repo, epic: result.epic });
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
        {initiative ? null : input(draft.initiativeTitle, "Initiative name", (text) => setDraft({ ...draft, initiativeTitle: text }))}
        {input(draft.epicTitle, initiative ? "Phase name" : "First phase name", (text) => setDraft({ ...draft, epicTitle: text }))}
        <Button label={busy ? "Creating…" : "Create"} primary disabled={busy} styles={styles} onPress={() => void submit()} />
        <Button label="Cancel" styles={styles} onPress={() => setDraft(null)} />
      </View>
    ) : null;

  return (
    <View style={styles.repoForm}>
      <View style={styles.head}>
        <Text style={[styles.muted, styles.flex]}>
          Initiatives live in each repo at .harness/initiatives/&lt;slug&gt;/epics/&lt;E#-name&gt;. Open an epic to run it here.
        </Text>
        <Button label="Close" styles={styles} onPress={onCancel} />
      </View>
      <View style={styles.repoRow}>
        <TextInput
          value={runner}
          onChangeText={setRunner}
          placeholder="Runner module (optional) — exports createHarnessRunner"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          onSubmitEditing={() => onPicked({ runner: runner.trim() })}
        />
        <Button label="Save runner" styles={styles} onPress={() => onPicked({ runner: runner.trim() })} />
      </View>
      {error ? <Text style={styles.danger}>{error}</Text> : null}
      {!repos && !error ? <Text style={styles.muted}>Looking through your repos…</Text> : null}
      {repos?.length === 0 ? <Text style={styles.muted}>No git repos in Paseo yet. Add one as a project first.</Text> : null}
      {repos?.map((repo) => (
        <View key={repo.repo} style={styles.related}>
          <View style={styles.head}>
            <Text style={[styles.foldedTitle, styles.flex]} numberOfLines={1}>
              {repo.name}
              {repo.initiatives.length === 0 ? <Text style={styles.hint}>{"  ·  no initiatives"}</Text> : null}
            </Text>
            <Button
              label="New initiative"
              styles={styles}
              onPress={() => setDraft({ repo: repo.repo, initiative: "", initiativeTitle: "", epicTitle: "" })}
            />
          </View>
          {form(repo.repo, "")}
          {repo.initiatives.map((initiative) => (
            <View key={initiative.slug} style={[styles.previewBox, styles.related]}>
              <View style={styles.head}>
                <Text style={[styles.nodeTitle, styles.flex]} numberOfLines={1}>
                  {initiative.title}
                  <Text style={styles.hint}>{`  ·  ${initiative.slug}`}</Text>
                </Text>
                <Button
                  label="New phase"
                  styles={styles}
                  onPress={() =>
                    setDraft({ repo: repo.repo, initiative: initiative.slug, initiativeTitle: "", epicTitle: "" })
                  }
                />
              </View>
              {form(repo.repo, initiative.slug)}
              {initiative.epics.length === 0 ? <Text style={styles.hint}>No phases yet.</Text> : null}
              {initiative.epics.map((epic) => {
                const current = active?.repo === repo.repo && active.epic === epic.path;
                return (
                  <View key={epic.path} style={styles.repoRow}>
                    <Text style={[styles.muted, styles.flex]} numberOfLines={1}>
                      <Text style={styles.nodeId}>{epic.id}</Text>
                      {`  ${epic.title}  ·  ${epic.merged}/${epic.stories} merged`}
                    </Text>
                    {current ? <Text style={styles.hint}>on the board</Text> : null}
                    <Button label="Open" primary={current} disabled={busy} styles={styles} onPress={() => onPicked({ repo: repo.repo, epic: epic.path })} />
                  </View>
                );
              })}
            </View>
          ))}
        </View>
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
    headText: { flex: 1, minWidth: 220, gap: 4 },
    headActions: { flexDirection: "row" as const, gap: 8 },
    muted: { color: c.foregroundMuted, fontSize: 12.5 },
    danger: { color: c.statusDanger, fontSize: 12.5 },
    hint: { color: c.foregroundMuted, fontSize: 11.5 },
    sectionLabel: { color: c.foregroundMuted, fontSize: 11, letterSpacing: 0.8, fontWeight: "600" as const },
    mono: { color: c.foreground, fontFamily: "monospace", fontSize: 12 },
    link: { color: c.accent, fontFamily: "monospace", fontSize: 12, textDecorationLine: "underline" as const },
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
    liveDot: { width: 7, height: 7, borderRadius: 4 },
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
    update: {
      flexDirection: "row" as const,
      gap: 10,
      alignItems: "baseline" as const,
      paddingVertical: 5,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    updateTime: { color: c.foregroundMuted, fontFamily: "monospace", fontSize: 11.5, width: 64 },
    updateWho: { fontFamily: "monospace", fontSize: 12, fontWeight: "600" as const },
    updateText: { color: c.foreground, fontSize: 12.5, flex: 1 },
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
      paddingHorizontal: 11,
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
    related: { gap: 6 },
  };
}
