import assert from "node:assert/strict";
import { test } from "node:test";
import type { EpicBoard, EpicBoardState, EpicStory } from "../shared/orchestration";
import { IDLE_POLL_MS, POLL_MS, boardKey, findSelected, pollDelay, showFold, toggleFold } from "./epic-board-model";

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

test("toggleFold adds then removes a key and leaves the input alone", () => {
  const empty = new Set<string>();
  const folded = toggleFold(empty, "a");
  assert.notEqual(folded, empty);
  assert.deepEqual([...empty], []);
  assert.deepEqual([...folded], ["a"]);
  const shown = toggleFold(folded, "a");
  assert.notEqual(shown, folded);
  assert.deepEqual([...folded], ["a"]);
  assert.deepEqual([...shown], []);
});

test("showFold removes a folded key, is a copy when it isn't folded, and leaves the input alone", () => {
  const folded = new Set(["a", "b"]);
  const shown = showFold(folded, "a");
  assert.notEqual(shown, folded);
  assert.deepEqual([...folded], ["a", "b"]);
  assert.deepEqual([...shown], ["b"]);
  const same = showFold(folded, "c");
  assert.notEqual(same, folded);
  assert.deepEqual([...same], ["a", "b"]);
  assert.deepEqual([...folded], ["a", "b"]);
});

function story(id: string): EpicStory {
  return { id, title: id, status: "todo", dependsOn: [], blockedBy: "", blockedReason: "" } as unknown as EpicStory;
}

test("findSelected resolves the selected board and story", () => {
  const one = board({ stories: [story("S1"), story("S2")] });
  const other = board({ stories: [story("S1")] }, { initiative: "other" });
  const found = findSelected([other, one], { board: boardKey(one), story: "S2" });
  assert.equal(found?.board, one);
  assert.equal(found?.story.id, "S2");
});

test("findSelected is null when nothing matches", () => {
  const one = board({ stories: [story("S1")] });
  const empty = board(null, { initiative: "empty" });
  assert.equal(findSelected([one], null), null);
  assert.equal(findSelected(null, { board: boardKey(one), story: "S1" }), null);
  assert.equal(findSelected([one], { board: "/repo\nnope", story: "S1" }), null);
  assert.equal(findSelected([one], { board: boardKey(one), story: "S9" }), null);
  assert.equal(findSelected([empty], { board: boardKey(empty), story: "S1" }), null);
});
