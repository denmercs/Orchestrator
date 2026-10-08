// The initiative boards' rules, as data (see client/epic-board.tsx). Kept free of React and the
// Paseo client so they can be tested on their own.

import type { EpicBoard } from "../shared/orchestration";

// Fast while something is moving (a loop runs or a phase is still being planned), slow otherwise:
// every poll reads every initiative in every repo.
export const POLL_MS = 3000;
export const IDLE_POLL_MS = 10_000;

// A board's identity, even when its state is null.
export const boardKey = (board: EpicBoard) => `${board.repo}\n${board.initiative}`;

export const lively = (board: EpicBoard) =>
  board.state !== null && (board.state.loop === "on" || board.state.plan?.status !== "agreed");

// Fast until the first read lands.
export const pollDelay = (boards: readonly EpicBoard[] | null) =>
  (boards?.some(lively) ?? true) ? POLL_MS : IDLE_POLL_MS;
