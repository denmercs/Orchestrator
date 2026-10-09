import assert from "node:assert/strict";
import { test } from "node:test";
import { burnPerTurn, contextPanel, estimateSplit, toolOutputChars, type TimelineItem } from "./context-panel";
import type { ContextReading, Thresholds } from "./context-meter";

test("burnPerTurn: fewer than 2 readings has no burn", () => {
  assert.equal(burnPerTurn([]), null);
  assert.equal(burnPerTurn([40_000]), null);
});

test("burnPerTurn: averages the deltas available when there are fewer than 5", () => {
  assert.equal(burnPerTurn([10_000, 14_000, 20_000]), 5_000);
});

test("burnPerTurn: averages only the last 5 deltas", () => {
  // The first jump (0 → 100_000) falls outside the window of the last 6 readings.
  assert.equal(burnPerTurn([0, 100_000, 101_000, 102_000, 104_000, 106_000, 110_000]), 2_000);
});

test("burnPerTurn: a negative average clamps to 0", () => {
  assert.equal(burnPerTurn([50_000, 52_000, 30_000]), 0);
});

const thresholds: Thresholds = { amber: 100_000, red: 150_000 };

function reading(used: number | null, max: number | null): ContextReading {
  const level = used === null ? "unknown" : used >= 150_000 ? "red" : used >= 100_000 ? "amber" : "ok";
  return { used, max, level, capability: "full", strategy: "native" };
}

test("contextPanel: percent and markers as a share of max", () => {
  const panel = contextPanel({ reading: reading(50_000, 200_000), turns: [], thresholds, strategy: "native" });
  assert.equal(panel.used, 50_000);
  assert.equal(panel.max, 200_000);
  assert.equal(panel.percent, 25);
  assert.equal(panel.level, "ok");
  assert.deepEqual(panel.markers, {
    warn: { tokens: 100_000, percent: 50 },
    act: { tokens: 150_000, percent: 75, word: "compact" },
  });
});

test("contextPanel: marker percents round", () => {
  const panel = contextPanel({ reading: reading(10_000, 300_000), turns: [], thresholds, strategy: "native" });
  assert.equal(panel.percent, 3);
  assert.equal(panel.markers.warn.percent, 33);
  assert.equal(panel.markers.act.percent, 50);
});

test("contextPanel: no max leaves percent and marker percents null", () => {
  const panel = contextPanel({ reading: reading(50_000, null), turns: [], thresholds, strategy: "fresh" });
  assert.equal(panel.percent, null);
  assert.deepEqual(panel.markers, {
    warn: { tokens: 100_000, percent: null },
    act: { tokens: 150_000, percent: null, word: "hand off" },
  });
});

test("contextPanel: turnsToAct is now at act and past it", () => {
  const turns = [140_000, 145_000];
  for (const used of [150_000, 170_000]) {
    const panel = contextPanel({ reading: reading(used, 200_000), turns, thresholds, strategy: "native" });
    assert.equal(panel.turnsToAct, "now");
    assert.equal(panel.level, "red");
  }
});

test("contextPanel: turnsToAct rounds up below act", () => {
  // burn 4_000; (150_000 - 130_000) / 4_000 = 5 exactly, (150_000 - 131_000) / 4_000 = 4.75 → 5
  const exact = contextPanel({ reading: reading(130_000, 200_000), turns: [122_000, 126_000, 130_000], thresholds, strategy: "native" });
  assert.equal(exact.burn, 4_000);
  assert.equal(exact.turnsToAct, 5);
  const partial = contextPanel({ reading: reading(131_000, 200_000), turns: [122_000, 126_000, 130_000], thresholds, strategy: "native" });
  assert.equal(partial.turnsToAct, 5);
});

test("contextPanel: turnsToAct is null with no burn or a burn of 0", () => {
  const noBurn = contextPanel({ reading: reading(50_000, 200_000), turns: [50_000], thresholds, strategy: "native" });
  assert.equal(noBurn.burn, null);
  assert.equal(noBurn.turnsToAct, null);
  const flat = contextPanel({ reading: reading(50_000, 200_000), turns: [50_000, 50_000], thresholds, strategy: "native" });
  assert.equal(flat.burn, 0);
  assert.equal(flat.turnsToAct, null);
});

test("toolOutputChars: counts only completed tool_call output and content strings", () => {
  const items: TimelineItem[] = [
    { type: "tool_call", status: "completed", detail: { type: "shell", output: "12345" } },
    { type: "tool_call", status: "completed", detail: { type: "read", content: "abc" } },
    { type: "tool_call", status: "running", detail: { type: "shell", output: "not yet" } },
    { type: "tool_call", status: "failed", detail: { type: "shell", output: "boom" } },
    { type: "tool_call", status: "canceled", detail: { type: "read", content: "skipped" } },
    { type: "tool_call", status: "completed", detail: { type: "unknown", output: { not: "a string" } } },
    { type: "tool_call", status: "completed", detail: { type: "edit" } },
    { type: "assistant_message", status: "completed", detail: { type: "shell", output: "ignored" } },
    { type: "compaction", status: "completed" },
  ];
  assert.equal(toolOutputChars(items), 8);
  assert.equal(toolOutputChars([]), 0);
});

test("estimateSplit: tool is chars / 4 rounded, conversation is the rest", () => {
  // 10_002 / 4 = 2_500.5 → 2_501; 50_000 - 20_000 - 2_501 = 27_499
  assert.deepEqual(estimateSplit({ used: 50_000, system: 20_000, toolChars: 10_002 }), {
    system: 20_000,
    conversation: 27_499,
    tool: 2_501,
  });
  assert.deepEqual(estimateSplit({ used: 30_000, system: 20_000, toolChars: 40_000 }), {
    system: 20_000,
    conversation: 0,
    tool: 10_000,
  });
});

test("estimateSplit: null when an input is missing", () => {
  assert.equal(estimateSplit({ used: null, system: 20_000, toolChars: 0 }), null);
  assert.equal(estimateSplit({ used: 50_000, system: null, toolChars: 0 }), null);
  assert.equal(estimateSplit({ used: 50_000, system: 20_000, toolChars: null }), null);
});

test("estimateSplit: null when conversation would be negative", () => {
  assert.equal(estimateSplit({ used: 30_000, system: 20_000, toolChars: 40_004 }), null);
  assert.equal(estimateSplit({ used: 10_000, system: 20_000, toolChars: 0 }), null);
});

test("contextPanel: split from the optional split input, null when absent", () => {
  const base = { reading: reading(50_000, 200_000), turns: [], thresholds, strategy: "native" as const };
  assert.equal(contextPanel(base).split, null);
  assert.equal(contextPanel({ ...base, split: null }).split, null);
  assert.equal(contextPanel({ ...base, split: { system: null, toolChars: 400 } }).split, null);
  assert.deepEqual(contextPanel({ ...base, split: { system: 20_000, toolChars: 4_000 } }).split, {
    system: 20_000,
    conversation: 29_000,
    tool: 1_000,
  });
});
