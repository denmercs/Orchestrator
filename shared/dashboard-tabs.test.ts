import assert from "node:assert/strict";
import { test } from "node:test";
import type { EpicBoard, JiraIssue, ProdPulse } from "./orchestration";
import { TABS, tabCounts } from "./dashboard-tabs";

const boards = (n: number) => Array.from({ length: n }, () => ({}) as EpicBoard);
const issues = (n: number) => Array.from({ length: n }, () => ({}) as JiraIssue);
const pulse = (issueCount: number, olderCount: number) => ({
  available: true,
  issues: Array.from({ length: issueCount }, () => ({}) as ProdPulse["issues"][number]),
  older: Array.from({ length: olderCount }, () => ({}) as ProdPulse["older"][number]),
});

test("the dashboard has five tabs in order: Initiatives, Today, Todos, Board, Pulse", () => {
  assert.deepEqual(
    TABS.map((tab) => [tab.id, tab.label]),
    [
      ["initiatives", "Initiatives"],
      ["today", "Today"],
      ["todos", "Todos"],
      ["board", "Board"],
      ["pulse", "Pulse"],
    ],
  );
});

test("with every source loaded, tabs count boards, sprint issues and every pulse bug; Today and Todos stay null", () => {
  assert.deepEqual(tabCounts({ boards: boards(3), sprintIssues: issues(5), pulse: pulse(2, 4) }), {
    initiatives: 3,
    today: null,
    todos: null,
    board: 5,
    pulse: 6,
  });
});

test("loaded but empty sources count 0, not null", () => {
  assert.deepEqual(tabCounts({ boards: [], sprintIssues: [], pulse: pulse(0, 0) }), {
    initiatives: 0,
    today: null,
    todos: null,
    board: 0,
    pulse: 0,
  });
});

const allNull = { initiatives: null, today: null, todos: null, board: null, pulse: null };

test("boards not loaded gives a null Initiatives count", () => {
  assert.equal(tabCounts({ boards: null, sprintIssues: issues(5), pulse: pulse(2, 4) }).initiatives, null);
});

test("no sprint loaded gives a null Board count", () => {
  assert.equal(tabCounts({ boards: boards(3), sprintIssues: null, pulse: pulse(2, 4) }).board, null);
});

test("pulse not loaded gives a null Pulse count", () => {
  assert.equal(tabCounts({ boards: boards(3), sprintIssues: issues(5), pulse: null }).pulse, null);
});

test("pulse unavailable gives a null Pulse count even when it lists bugs", () => {
  const unavailable = { ...pulse(2, 4), available: false };
  assert.equal(tabCounts({ boards: boards(3), sprintIssues: issues(5), pulse: unavailable }).pulse, null);
});

test("with no source loaded, every count is null", () => {
  assert.deepEqual(tabCounts({ boards: null, sprintIssues: null, pulse: null }), allNull);
});
