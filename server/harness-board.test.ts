import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { boardPhase } from "./harness-board";

const ROOT = resolve("/repos/app");
const phase = (n: number, stories: number, merged: number) => ({
  id: String(n),
  title: `Phase ${n}`,
  path: `.harness/initiatives/search/phases/${n}-p`,
  stories,
  merged,
});
const initiative = (...epics: ReturnType<typeof phase>[]) => ({
  slug: "search",
  title: "Search",
  tracker: "local" as const,
  loop: "off" as const,
  epics,
});
const NONE = { repo: "", epic: "" };

test("shows the first phase that isn't fully merged", () => {
  assert.equal(boardPhase(ROOT, initiative(phase(1, 2, 2), phase(2, 3, 1), phase(3, 1, 0)), NONE), phase(2, 0, 0).path);
});

test("a phase with no stories yet is still being planned, so it counts as unfinished", () => {
  assert.equal(boardPhase(ROOT, initiative(phase(1, 2, 2), phase(2, 0, 0)), NONE), phase(2, 0, 0).path);
});

test("falls back to the last phase when every phase is merged", () => {
  assert.equal(boardPhase(ROOT, initiative(phase(1, 2, 2), phase(2, 1, 1)), NONE), phase(2, 0, 0).path);
});

test("the picked phase wins when it belongs to this initiative", () => {
  const picked = { repo: "/repos/app/", epic: phase(1, 0, 0).path };
  assert.equal(boardPhase(ROOT, initiative(phase(1, 2, 2), phase(2, 3, 1)), picked), phase(1, 0, 0).path);
});

test("a phase picked in another repo or initiative doesn't move this board", () => {
  const items = initiative(phase(1, 2, 2), phase(2, 3, 1));
  assert.equal(boardPhase(ROOT, items, { repo: "/repos/other", epic: phase(1, 0, 0).path }), phase(2, 0, 0).path);
  assert.equal(boardPhase(ROOT, items, { repo: ROOT, epic: ".harness/initiatives/other/phases/1-p" }), phase(2, 0, 0).path);
});

test("an initiative with no phases has no board", () => {
  assert.equal(boardPhase(ROOT, initiative(), NONE), null);
});
