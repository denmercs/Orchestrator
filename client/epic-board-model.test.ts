import assert from "node:assert/strict";
import { test } from "node:test";
import type { EpicBoard, EpicBoardState } from "../shared/orchestration";
import { IDLE_POLL_MS, POLL_MS, boardKey, pollDelay } from "./epic-board-model";

function board(state: Partial<EpicBoardState> | null, rest: Partial<EpicBoard> = {}): EpicBoard {
  return {
    repo: "/repo",
    initiative: "redesign",
    state:
      state &&
      ({
        epic: { id: "1", title: "Phase 1", dir: "phases/1" },
        initiative: "Redesign",
        initiativeSlug: "redesign",
        loop: "off",
        plan: { warnings: [], jira: false, status: "agreed" },
        tracker: "local",
        next: { story: null, reason: "" },
        repoUrl: "",
        stories: [],
        ...state,
      } as EpicBoardState),
    error: null,
    ...rest,
  };
}

test("boardKey joins repo and initiative", () => {
  assert.equal(boardKey(board(null, { repo: "/a", initiative: "b" })), "/a\nb");
});

test("pollDelay is fast before the first read", () => {
  assert.equal(POLL_MS, 3000);
  assert.equal(pollDelay(null), POLL_MS);
});

test("pollDelay is fast while any board is lively", () => {
  assert.equal(pollDelay([board({}), board({ loop: "on" })]), POLL_MS);
  assert.equal(pollDelay([board({ plan: null })]), POLL_MS);
  assert.equal(pollDelay([board({ plan: { warnings: [], jira: false, status: "draft" } })]), POLL_MS);
});

test("pollDelay is slow when every board is settled", () => {
  assert.equal(IDLE_POLL_MS, 10_000);
  assert.equal(pollDelay([board({}), board(null)]), IDLE_POLL_MS);
  assert.equal(pollDelay([]), IDLE_POLL_MS);
});
