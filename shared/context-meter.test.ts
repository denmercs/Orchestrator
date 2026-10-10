import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectCompaction,
  nextWarning,
  readContext,
  shouldAutoCompact,
  type ContextReading,
  type CompactionItem,
  type ContextSnapshot,
  type Level,
  type Thresholds,
  type WarningMemory,
} from "./context-meter";

const THRESHOLDS: Thresholds = { amber: 100_000, red: 150_000 };
const MAX = 200_000;

function snapshot(used: number | null, commands: string[] = ["compact"]): ContextSnapshot {
  return {
    usage: used === null ? null : { contextWindowUsedTokens: used, contextWindowMaxTokens: MAX },
    commands: commands.map((name) => ({ name })),
  };
}

test("readContext: unknown usage reads unknown and basic", () => {
  assert.deepEqual(readContext(snapshot(null, []), THRESHOLDS), {
    used: null,
    max: null,
    level: "unknown",
    capability: "basic",
    strategy: "fresh",
  });
});

test("readContext: usage without a used count reads unknown", () => {
  const reading = readContext({ usage: { contextWindowMaxTokens: MAX }, commands: [] }, THRESHOLDS);
  assert.equal(reading.level, "unknown");
  assert.equal(reading.capability, "basic");
});

test("readContext: 99k is ok, 100k is amber, 150k is red", () => {
  assert.equal(readContext(snapshot(99_999), THRESHOLDS).level, "ok");
  assert.equal(readContext(snapshot(100_000), THRESHOLDS).level, "amber");
  assert.equal(readContext(snapshot(150_000), THRESHOLDS).level, "red");
});

test("readContext: /compact listed with usage is full and native", () => {
  assert.deepEqual(readContext(snapshot(120_000, ["compact"]), THRESHOLDS), {
    used: 120_000,
    max: MAX,
    level: "amber",
    capability: "full",
    strategy: "native",
  });
});

test("readContext: no /compact with usage is partial and fresh", () => {
  const reading = readContext(snapshot(120_000, ["review"]), THRESHOLDS);
  assert.equal(reading.capability, "partial");
  assert.equal(reading.strategy, "fresh");
});

test("readContext: only autocompact listed is fresh", () => {
  assert.equal(readContext(snapshot(120_000, ["autocompact"]), THRESHOLDS).strategy, "fresh");
});

test("readContext: basic with /compact listed is still native", () => {
  const reading = readContext(snapshot(null, ["compact"]), THRESHOLDS);
  assert.equal(reading.capability, "basic");
  assert.equal(reading.strategy, "native");
});

function reading(level: Level): ContextReading {
  const used = { ok: 50_000, amber: 120_000, red: 160_000, unknown: null }[level];
  return {
    used,
    max: used === null ? null : MAX,
    level,
    capability: used === null ? "basic" : "full",
    strategy: "native",
  };
}

const fresh: WarningMemory = { warned: [], mode: "normal", auto: "armed" };

test("nextWarning: first amber warns amber", () => {
  assert.deepEqual(nextWarning(fresh, reading("amber")), { level: "amber" });
});

test("nextWarning: amber again after an amber warning is silent", () => {
  assert.equal(nextWarning({ warned: ["amber"], mode: "normal", auto: "armed" }, reading("amber")), null);
});

test("nextWarning: red after amber warns red", () => {
  assert.deepEqual(nextWarning({ warned: ["amber"], mode: "normal", auto: "armed" }, reading("red")), { level: "red" });
});

test("nextWarning: a jump from ok straight to red warns red only", () => {
  assert.equal(nextWarning(fresh, reading("ok")), null);
  assert.deepEqual(nextWarning(fresh, reading("red")), { level: "red" });
});

test("nextWarning: red again after a red warning is silent", () => {
  assert.equal(nextWarning({ warned: ["amber", "red"], mode: "normal", auto: "armed" }, reading("red")), null);
});

test("nextWarning: Remind skips amber and warns at red", () => {
  const remind: WarningMemory = { warned: [], mode: "remind", auto: "armed" };
  assert.equal(nextWarning(remind, reading("amber")), null);
  assert.deepEqual(nextWarning(remind, reading("red")), { level: "red" });
});

test("nextWarning: Ignore silences amber and red", () => {
  const ignore: WarningMemory = { warned: [], mode: "ignore", auto: "armed" };
  assert.equal(nextWarning(ignore, reading("amber")), null);
  assert.equal(nextWarning(ignore, reading("red")), null);
});

test("nextWarning: unknown level never warns", () => {
  assert.equal(nextWarning(fresh, reading("unknown")), null);
});

function at(used: number): ContextReading {
  return { used, max: MAX, level: "ok", capability: "full", strategy: "native" };
}

const completed: CompactionItem = { type: "compaction", status: "completed", preTokens: 140_000 };

test("detectCompaction: a completed compaction item beats an inferred drop", () => {
  assert.deepEqual(detectCompaction(at(130_000), at(20_000), [completed]), {
    kind: "native",
    preTokens: 140_000,
  });
});

test("detectCompaction: a loading compaction item alone is not native", () => {
  const loading: CompactionItem = { type: "compaction", status: "loading" };
  assert.notEqual(detectCompaction(at(130_000), at(125_000), [loading])?.kind, "native");
});

test("detectCompaction: a drop under half with no item is inferred", () => {
  assert.deepEqual(detectCompaction(at(130_000), at(40_000), [{ type: "assistant_message" }]), {
    kind: "inferred",
    preTokens: 130_000,
  });
});

test("detectCompaction: a small drop or a rise is no compaction", () => {
  assert.equal(detectCompaction(at(130_000), at(100_000), []), null);
  assert.equal(detectCompaction(at(130_000), at(140_000), []), null);
});

test("detectCompaction: no previous reading and no item is no compaction", () => {
  assert.equal(detectCompaction(null, at(40_000), []), null);
});

const GO = { enabled: true, running: false, pendingPermissions: false, completed: true, loop: false };

test("shouldAutoCompact: red, armed and every guard clear compacts", () => {
  assert.equal(shouldAutoCompact(fresh, reading("red"), GO), true);
});

test("shouldAutoCompact: amber and ok do not compact", () => {
  assert.equal(shouldAutoCompact(fresh, reading("amber"), GO), false);
  assert.equal(shouldAutoCompact(fresh, reading("ok"), GO), false);
});

test("shouldAutoCompact: Ignore does not compact", () => {
  assert.equal(shouldAutoCompact({ ...fresh, mode: "ignore" }, reading("red"), GO), false);
});

test("shouldAutoCompact: already sent or skipped does not compact", () => {
  assert.equal(shouldAutoCompact({ ...fresh, auto: "sent" }, reading("red"), GO), false);
  assert.equal(shouldAutoCompact({ ...fresh, auto: "skipped" }, reading("red"), GO), false);
});

test("shouldAutoCompact: running, pending permission, unfinished turn, loop agent or setting off do not compact", () => {
  assert.equal(shouldAutoCompact(fresh, reading("red"), { ...GO, running: true }), false);
  assert.equal(shouldAutoCompact(fresh, reading("red"), { ...GO, pendingPermissions: true }), false);
  assert.equal(shouldAutoCompact(fresh, reading("red"), { ...GO, completed: false }), false);
  assert.equal(shouldAutoCompact(fresh, reading("red"), { ...GO, loop: true }), false);
  assert.equal(shouldAutoCompact(fresh, reading("red"), { ...GO, enabled: false }), false);
});
