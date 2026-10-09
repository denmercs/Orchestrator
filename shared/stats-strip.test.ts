import assert from "node:assert/strict";
import { test } from "node:test";
import { gatesOf } from "./gates";
import type { EpicBoard, EpicBoardState, EpicStory } from "./orchestration";
import { startOfDay, statsOf, type Stat } from "./stats-strip";

function story(id: string, fields: Partial<EpicStory> = {}): EpicStory {
  return {
    id,
    title: `Story ${id}`,
    status: "todo",
    dependsOn: [],
    blockedBy: "",
    blockedReason: "",
    blockedFrom: "",
    skillWarnings: "",
    discoveredFrom: "",
    pr: null,
    ci: "",
    workspace: "",
    agent: "",
    ready: false,
    ...fields,
  };
}

function board(initiative: string, stories: EpicStory[] | null): EpicBoard {
  if (stories === null) return { repo: "/repo", initiative, state: null, error: "unreadable" };
  const state: EpicBoardState = {
    epic: { id: "1", title: "Header and tabs", dir: "phases/1-header-and-tabs" },
    initiative: initiative,
    initiativeSlug: initiative,
    loop: "on",
    plan: null,
    tracker: "local",
    next: { story: null, reason: "" },
    repoUrl: "",
    stories,
  };
  return { repo: "/repo", initiative, state, error: null };
}

const BOARDS = [
  board("one", [
    story("S1", { status: "planning" }),
    story("S2", { status: "implementing" }),
    story("S3", { status: "awaiting-approval" }),
    story("S4", { status: "merged", pr: 40 }),
    story("S5", { status: "todo", ready: true }),
  ]),
  board("two", [
    story("S1", { status: "reviewing" }),
    story("S2", { status: "pr-open", ci: "green", pr: 41 }),
    story("S3", { status: "merged", pr: 39 }),
    story("S4", { status: "todo", ready: true }),
    story("S5", { status: "todo" }),
  ]),
  board("broken", null),
];

const BUDGET = { dailyBudgetUsd: 25, storyCapUsd: 5 };
const SPEND = { spendToday: 6.849, spendWeek: 31.4 };

const byLabel = (stats: Stat[]) => Object.fromEntries(stats.map((stat) => [stat.label, stat]));

test("statsOf: the five stats in order, with value, sub and tone", () => {
  const stats = statsOf({ boards: BOARDS, gates: gatesOf(BOARDS), spend: SPEND, budget: BUDGET });
  assert.deepEqual(stats, [
    { label: "Running", value: "3", sub: "agents working", tone: "default" },
    { label: "Ready", value: "2", sub: "waiting to start", tone: "default" },
    { label: "Needs you", value: "2", sub: "agents paused at gates", tone: "warning" },
    { label: "Merged", value: "2/10", sub: "stories across initiatives", tone: "default" },
    { label: "Spend today", value: "$6.85", sub: "of $25 budget · $31.40 this week", tone: "default" },
  ]);
});

test("statsOf: Needs you is default at zero gates", () => {
  const stats = byLabel(statsOf({ boards: BOARDS, gates: [], spend: SPEND, budget: BUDGET }));
  assert.equal(stats["Needs you"].value, "0");
  assert.equal(stats["Needs you"].tone, "default");
});

test("statsOf: no boards gives zero counts and 0/0 merged", () => {
  const stats = byLabel(statsOf({ boards: [], gates: [], spend: SPEND, budget: BUDGET }));
  assert.equal(stats.Running.value, "0");
  assert.equal(stats.Ready.value, "0");
  assert.equal(stats.Merged.value, "0/0");
});

test("statsOf: board stats are a dash until the boards load", () => {
  const stats = byLabel(statsOf({ boards: null, gates: [], spend: SPEND, budget: BUDGET }));
  assert.equal(stats.Running.value, "—");
  assert.equal(stats.Ready.value, "—");
  assert.equal(stats.Merged.value, "—");
  assert.equal(stats["Needs you"].value, "0");
  assert.equal(stats["Spend today"].value, "$6.85");
});

test("statsOf: Spend today is a dash while the summary is loading or failed", () => {
  const stats = byLabel(statsOf({ boards: BOARDS, gates: [], spend: null, budget: BUDGET }));
  assert.equal(stats["Spend today"].value, "—");
  assert.equal(stats["Spend today"].sub, "of $25 budget");
});

test("statsOf: a fractional budget shows cents", () => {
  const stats = byLabel(statsOf({ boards: [], gates: [], spend: SPEND, budget: { dailyBudgetUsd: 12.5, storyCapUsd: 5 } }));
  assert.equal(stats["Spend today"].sub, "of $12.50 budget · $31.40 this week");
});

test("startOfDay: local midnight of the same day", () => {
  const day = startOfDay(new Date(2026, 9, 8, 14, 37, 12, 345));
  assert.equal(day.getTime(), new Date(2026, 9, 8).getTime());
});
