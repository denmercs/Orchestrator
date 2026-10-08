import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextStatus } from "../shared/context";
import type { ContextReading } from "../shared/context-meter";
import {
  createRequestSequence,
  createToastQueue,
  formatTokens,
  pillMenu,
  pillView,
  stepTiles,
  summaryTiles,
  usageChanged,
} from "./context-pill-model";

function status(reading: Partial<ContextReading>, rest: Partial<ContextStatus> = {}): ContextStatus {
  return {
    agentId: "a1",
    reading: { used: 82_000, max: 200_000, level: "ok", capability: "full", strategy: "native", ...reading },
    warned: [],
    mode: "normal",
    red: 150_000,
    ...rest,
  };
}

test("formatTokens: as is under 1000, k above, M from a million", () => {
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(182_400), "182k");
  assert.equal(formatTokens(1_200_000), "1.2M");
});

test("pillView: used/max with the level as tone and the strategy in the title", () => {
  const ok = pillView(status({}));
  assert.equal(ok.label, "82k / 200k");
  assert.equal(ok.tone, "ok");
  assert.match(ok.title, /Compact: \/compact in place/);

  const amber = pillView(status({ used: 120_000, level: "amber", strategy: "fresh" }));
  assert.equal(amber.label, "120k / 200k");
  assert.equal(amber.tone, "amber");
  assert.match(amber.title, /amber/);
  assert.match(amber.title, /Compact: fresh session/);

  assert.equal(pillView(status({ used: 160_000, level: "red" })).tone, "red");
});

test("pillView: grey Context ? with no usage or no status", () => {
  for (const view of [pillView(status({ used: null, max: null, level: "unknown" })), pillView(null)]) {
    assert.equal(view.label, "Context ?");
    assert.equal(view.tone, "unknown");
    assert.equal(view.title, "Context unknown: this agent reports no usage");
  }
});

test("pillMenu: compact, fresh, remind at red, ignore, each with its action", () => {
  const menu = pillMenu(status({}), false);
  assert.deepEqual(
    menu.map((item) => [item.action, item.title, item.disabled]),
    [
      ["compact", "Compact now", false],
      ["fresh", "Start fresh", false],
      ["remind", "Remind me at 150k", false],
      ["ignore", "Ignore", false],
    ],
  );
});

test("pillMenu: Remind and Ignore are off in their own mode; Compact and Fresh while running", () => {
  const disabled = (menu: ReturnType<typeof pillMenu>) => menu.filter((item) => item.disabled).map((item) => item.action);
  assert.deepEqual(disabled(pillMenu(status({}, { mode: "remind" }), false)), ["remind"]);
  assert.deepEqual(disabled(pillMenu(status({}, { mode: "ignore" }), false)), ["ignore"]);
  assert.deepEqual(disabled(pillMenu(status({}), true)), ["compact", "fresh"]);
});

test("toastQueue: the first load seeds, then one toast per session per level", () => {
  const queue = createToastQueue();
  queue.load([status({ used: 120_000, level: "amber" }, { agentId: "old", warned: ["amber"] }), null]);
  assert.deepEqual(queue.take("old"), []);

  queue.load([status({ used: 120_000, level: "amber" }, { warned: ["amber"] })]);
  assert.deepEqual(
    queue.take("a1").map((toast) => toast.variant),
    ["amber"],
  );
  queue.load([status({ used: 130_000, level: "amber" }, { warned: ["amber"] })]);
  assert.deepEqual(queue.take("a1"), []);

  queue.load([status({ used: 160_000, level: "red" }, { warned: ["amber", "red"] })]);
  queue.load([status({ used: 120_000, level: "amber" }, { agentId: "b2", warned: ["amber"] })]);
  const [red] = queue.take("a1");
  assert.equal(red.variant, "red");
  assert.match(red.message, /160k/);
  assert.deepEqual(queue.take("a1"), []);
  assert.equal(queue.take("b2").length, 1);
});

test("toastQueue: a failed action queues an error toast for that agent", () => {
  const queue = createToastQueue();
  queue.fail("a1", "That session is no longer running.");
  assert.deepEqual(queue.take("a1"), [{ variant: "error", message: "That session is no longer running." }]);
});

test("usageChanged: new agent, used/max change, or running → idle", () => {
  const usage = (used: number, max = 200_000) => ({ contextWindowUsedTokens: used, contextWindowMaxTokens: max });
  const idle = { status: "idle", lastUsage: usage(80_000) };
  assert.equal(usageChanged(undefined, idle), true);
  assert.equal(usageChanged(idle, { ...idle, lastUsage: usage(90_000) }), true);
  assert.equal(usageChanged(idle, { ...idle, lastUsage: usage(80_000, 1_000_000) }), true);
  assert.equal(usageChanged({ ...idle, status: "running" }, idle), true);

  assert.equal(usageChanged(idle, { ...idle, lastUsage: usage(80_000) }), false);
  assert.equal(usageChanged(idle, { ...idle, status: "running" }), false);
  assert.equal(usageChanged({ status: "idle", lastUsage: null }, { status: "idle" }), false);
});

test("summaryTiles: over threshold, warnings, taken vs ignored, auto, tokens avoided", () => {
  const tiles = summaryTiles({
    turns: 40,
    sessions: 6,
    sessionsOverThreshold: 2,
    warnings: 3,
    compactions: { native: 2, fresh: 1, inferred: 4 },
    ignored: 1,
    reminded: 1,
    tokensAvoided: 412_000,
    byStep: {},
  });
  assert.deepEqual(tiles, [
    { label: "Sessions over threshold", value: "2" },
    { label: "Warnings", value: "3" },
    { label: "Compactions", value: "taken 3 vs ignored 1" },
    { label: "Auto-compacts", value: "4" },
    { label: "Tokens avoided", value: "412k" },
  ]);
});

const emptySummary = {
  turns: 0,
  sessions: 0,
  sessionsOverThreshold: 0,
  warnings: 0,
  compactions: { native: 0, fresh: 0, inferred: 0 },
  ignored: 0,
  reminded: 0,
  tokensAvoided: 0,
  byStep: {},
};

test("stepTiles: loop order then the rest A-Z, tokens · turns · models", () => {
  const tiles = stepTiles({
    ...emptySummary,
    byStep: {
      zeta: { turns: 1, tokens: 950, models: ["unknown"] },
      pr: { turns: 2, tokens: 40_000, models: ["haiku"] },
      review: { turns: 3, tokens: 1_200_000, models: ["opus", "sonnet"] },
      alpha: { turns: 4, tokens: 12_000, models: ["sonnet"] },
      implement: { turns: 9, tokens: 956_000, models: ["sonnet"] },
      plan: { turns: 5, tokens: 300_000, models: ["opus"] },
      fix: { turns: 1, tokens: 80_000, models: ["sonnet"] },
    },
  });
  assert.deepEqual(tiles, [
    { label: "plan", value: "300k · 5 turns · opus" },
    { label: "implement", value: "956k · 9 turns · sonnet" },
    { label: "review", value: "1.2M · 3 turns · opus, sonnet" },
    { label: "fix", value: "80k · 1 turn · sonnet" },
    { label: "pr", value: "40k · 2 turns · haiku" },
    { label: "alpha", value: "12k · 4 turns · sonnet" },
    { label: "zeta", value: "950 · 1 turn · unknown" },
  ]);
});

test("stepTiles: no steps gives no tiles", () => {
  assert.deepEqual(stepTiles(emptySummary), []);
});

test("toastQueue: a level toasts again once a compaction re-arms it", () => {
  const queue = createToastQueue();
  queue.load([]);
  queue.load([status({ used: 120_000, level: "amber" }, { warned: ["amber"] })]);
  assert.equal(queue.take("a1").length, 1);
  queue.load([status({ used: 40_000, level: "ok" }, { warned: [] })]);
  queue.load([status({ used: 125_000, level: "amber" }, { warned: ["amber"] })]);
  assert.deepEqual(
    queue.take("a1").map((toast) => toast.variant),
    ["amber"],
  );
});

test("requestSequence: an older status fetch for an agent is stale once a newer one starts", () => {
  const requests = createRequestSequence();
  const first = requests.start(["a1", "b2"]);
  const second = requests.start(["a1"]);
  assert.equal(requests.isLatest("a1", first), false);
  assert.equal(requests.isLatest("b2", first), true);
  assert.equal(requests.isLatest("a1", second), true);
});
