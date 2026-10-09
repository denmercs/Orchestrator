// The initiative boards' rules, as data (see client/epic-board.tsx). Kept free of React and the
// Paseo client so they can be tested on their own.

import type { ContextStatus } from "../shared/context";
import { phaseLabel, type EpicBoard, type EpicBoardState, type EpicStory } from "../shared/orchestration";
import { boardKey, needsYou } from "../shared/gates";

export { boardKey };

// Fast while something is moving (a loop runs or a phase is still being planned), slow otherwise:
// every poll reads every initiative in every repo.
export const POLL_MS = 3000;
export const IDLE_POLL_MS = 10_000;

export const lively = (board: EpicBoard) =>
  board.state !== null && (board.state.loop === "on" || board.state.plan?.status !== "agreed");

// Fast until the first read lands.
export const pollDelay = (boards: readonly EpicBoard[] | null) =>
  (boards?.some(lively) ?? true) ? POLL_MS : IDLE_POLL_MS;

// Folds a shown panel or shows a folded one; never mutates the set it was given.
export function toggleFold(folded: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(folded);
  if (!next.delete(key)) next.add(key);
  return next;
}

// Shows a panel whether or not it was folded; never mutates the set it was given.
export function showFold(folded: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(folded);
  next.delete(key);
  return next;
}

export type Selection = { board: string; story: string };

// The selection is kept as keys so it survives a poll; this resolves it against the latest read.
export function findSelected(
  boards: readonly EpicBoard[] | null,
  selected: Selection | null,
): { board: EpicBoard; story: EpicStory } | null {
  if (!selected) return null;
  const board = boards?.find((item) => boardKey(item) === selected.board);
  const story = board?.state?.stories.find((item) => item.id === selected.story);
  return board && story ? { board, story } : null;
}

export type NodeKind = "merged" | "needs-you" | "running" | "ready" | "waiting";

// A node's border and fill, per the legend. Anything past todo that isn't merged or waiting on you
// has an agent on it.
export function nodeKind(story: EpicStory): NodeKind {
  if (story.status === "merged") return "merged";
  if (needsYou(story)) return "needs-you";
  if (story.status === "todo") return story.ready ? "ready" : "waiting";
  return "running";
}

export type EdgeTone = "danger" | "success" | "muted";

// A graph arrow from `dep` into `story`: red when either end failed (the story it feeds is blocked,
// or the dependency holding it up is), green once the dependency merges, muted otherwise.
export function edgeTone(story: EpicStory, dep: EpicStory | undefined): EdgeTone {
  if (story.status === "blocked" || dep?.status === "blocked") return "danger";
  if (dep?.status === "merged") return "success";
  return "muted";
}

// The header's "N/M merged" and its bar; an empty initiative is 0%.
export function mergedProgress(stories: readonly EpicStory[]) {
  const merged = stories.filter((story) => story.status === "merged").length;
  const total = stories.length;
  return { merged, total, pct: total ? Math.round((merged / total) * 100) : 0 };
}

const phaseOf = (state: EpicBoardState) =>
  [state.epic.id ? phaseLabel(state.epic.id) : "", state.epic.title].filter(Boolean).join(": ");

// The header's sub-line: "Phase 1: <title> · local".
export function sectionLine(state: EpicBoardState) {
  return `${phaseOf(state)} · ${state.tracker === "jira" ? "Jira" : "local"}`;
}

// The dashed box of an initiative with no stories: plan it, or its plan is still being written.
export function emptyLine(state: EpicBoardState) {
  return state.plan
    ? "Planning in progress. Stories appear once the plan is locked."
    : "No stories yet. Plan this initiative to break it into stories.";
}

const WORKING = new Set(["planning", "awaiting-approval", "implementing", "reviewing", "pr-open"]);

// The amber note at the top of an open section: what the loop is doing, that Start is ready, or
// that the plan is still open. Null when there is nothing to say (an empty initiative says it in
// its dashed box).
export function sectionNote(state: EpicBoardState): string | null {
  const { stories } = state;
  if (!stories.length) return null;
  const merged = stories.filter((story) => story.status === "merged").length;
  const left = stories.length - merged;
  if (state.loop === "on") {
    const working = stories.filter((story) => WORKING.has(story.status)).length;
    return `Running ${phaseOf(state) || "this phase"}: ${working} in progress · ${merged} merged · ${left - working} waiting. Stop only keeps new work from starting.`;
  }
  if (state.loop === "off" && state.plan?.status === "agreed" && left > 0) {
    return `Planning done. Start runs ${state.initiative || "Initiative"} phase by phase: each ready story gets its own worktree, and the rest follow as their dependencies merge.`;
  }
  if (state.plan && state.plan.status !== "agreed") {
    return 'Planning in progress. Say "lock" in the architecture session when the plan is ready.';
  }
  return null;
}

export type SectionAction = { kind: "stop" | "start" | "plan" | "start-planning"; label: string };

// The header's one obvious next step; everything else lives in the ⋯ menu. busy is the running
// action's key ("loop-stop:", "loop-start:", "plan-open:", "plan-phase:"). Start planning only when
// the initiative has neither stories nor a plan, so it never spawns a second architecture session.
export function sectionAction(state: EpicBoardState, busy: string | null): SectionAction | null {
  const left = state.stories.filter((story) => story.status !== "merged").length;
  const planning = Boolean(state.plan && state.plan.status !== "agreed");
  if (state.loop === "on") return { kind: "stop", label: busy === "loop-stop:" ? "Stopping…" : "Stop" };
  if (state.loop === "off" && left > 0 && !planning)
    return { kind: "start", label: busy === "loop-start:" ? "Starting…" : "Start" };
  if (state.plan) return { kind: "plan", label: busy === "plan-open:" ? "Opening…" : "View plan" };
  if (state.stories.length === 0)
    return { kind: "start-planning", label: busy === "plan-phase:" ? "Starting…" : "Start planning" };
  return null;
}

const RUNNING = new Set(["planning", "implementing", "reviewing", "pr-open", "blocked"]);

// The agents whose context the board asks for: running or blocked stories that have one.
export function contextAgents(stories: readonly EpicStory[]): string[] {
  return stories.filter((story) => RUNNING.has(story.status) && story.agent).map((story) => story.agent);
}

export type NodeContext = { pct: number; level: ContextStatus["reading"]["level"]; act: number; label: string };

// A node's $ bar: how full the context is, and where the red threshold (the "act" marker) sits.
// Null when the reading has no used or max.
export function nodeContext(status: ContextStatus | null): NodeContext | null {
  if (!status) return null;
  const { used, max, level } = status.reading;
  if (used == null || !max) return null;
  const pct = Math.min(100, Math.round((used / max) * 100));
  return { pct, level, act: Math.min(100, Math.round((status.red / max) * 100)), label: `${pct}%` };
}
