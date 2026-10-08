// The initiative boards' rules, as data (see client/epic-board.tsx). Kept free of React and the
// Paseo client so they can be tested on their own.

import type { EpicBoard, EpicStory } from "../shared/orchestration";
import { boardKey } from "../shared/gates";

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
