import assert from "node:assert/strict";
import { test } from "node:test";
import { MID_TURN_IDLE_MS, briefTestFailures, midTurnCheck, stuckCheck, testRuns, type StuckCounters } from "./stuck";
import type { ToolItem } from "./exploration";

const shell = (command: string, output: string): ToolItem => ({ type: "tool_call", status: "completed", detail: { type: "shell", command, output } });
const brief = (output: string) => shell(".harness/bin/brief npm test", `brief: exit 1 · 9 lines · full log .harness/logs/x.log\n${output}`);

test("briefTestFailures reads a raw log: TAP names, failing tests block, passing, and no summary", () => {
  const tap = ["not ok 3 - parses a turn", "not ok 3 - parses a turn", "# tests 5", "# fail 1"].join("\n");
  assert.deepEqual(briefTestFailures(tap), ["parses a turn"]);
  const block = ["✖ failing tests:", "✖ first one (1.2ms)", "ℹ tests 4", "ℹ fail 1"].join("\n");
  assert.deepEqual(briefTestFailures(block), ["first one"]);
  assert.deepEqual(briefTestFailures("# tests 5\n# pass 5\n# fail 0"), []);
  assert.equal(briefTestFailures("error TS2322: bad type"), null);
});

test("testRuns reads failing names from TAP not ok lines", () => {
  const output = ["not ok 3 - parses a turn", "  ---", "  error: boom", "  ...", "# tests 5", "# pass 4", "# fail 1"].join("\n");
  assert.deepEqual(testRuns([brief(output)]), [["parses a turn"]]);
});

test("testRuns reads failing names from the failing tests block", () => {
  const output = ["✖ failing tests:", "", "test at a.test.ts:1:1", "✖ first one (1.2ms)", "  AssertionError: x", "✖ second one (0.3ms)", "ℹ tests 4", "ℹ fail 2"].join("\n");
  assert.deepEqual(testRuns([brief(output)]), [["first one", "second one"]]);
});

test("testRuns reads a failing run whose tool call failed, from the error's content", () => {
  // Claude marks a non-zero exit as a failed tool call and puts the output on `error.content`.
  const item = {
    type: "tool_call",
    status: "failed",
    detail: { type: "shell", command: ".harness/bin/brief npm test" },
    error: { type: "tool_result", is_error: true, content: "Exit code 1\nbrief: exit 1\nnot ok 1 - parses a turn\n# tests 5\n# fail 1" },
  } as ToolItem;
  assert.deepEqual(testRuns([item]), [["parses a turn"]]);
});

test("testRuns gives [] for a passing run, one entry per run", () => {
  assert.deepEqual(testRuns([brief("# tests 5\n# pass 5\n# fail 0"), brief("ℹ tests 2\nℹ pass 2")]), [[], []]);
});

test("testRuns skips non-brief commands and brief runs with no test summary", () => {
  const failing = "not ok 1 - nope\n  ---\n  ...\n# tests 1\n# fail 1";
  assert.deepEqual(testRuns([shell("npm test", failing), brief("error TS2322: bad type"), { type: "assistant_message" }]), []);
});

const edit = (filePath: string): ToolItem => ({ type: "tool_call", status: "completed", detail: { type: "edit", filePath, newString: "x" } });
const read: ToolItem = { type: "tool_call", status: "completed", detail: { type: "read", filePath: "a.ts", content: "abc" } };
const fail = (...names: string[]) => brief([...names.map((n, i) => `not ok ${i + 1} - ${n}`), "# tests 5", "# fail 1"].join("\n"));
const pass = brief("# tests 5\n# pass 5\n# fail 0");
const zero: StuckCounters = { idle_turns: 0, fail_tests: [], fail_runs: 0 };
const opts = { step: "implement", subagents: false, stuckTurns: 3 };

test("stuckCheck counts idle turns on Implement and reaches evidence at stuckTurns", () => {
  let r = stuckCheck(zero, [read], opts);
  assert.equal(r.counters.idle_turns, 1);
  assert.equal(r.evidence, null);
  r = stuckCheck({ ...zero, idle_turns: 2 }, [read], opts);
  assert.equal(r.counters.idle_turns, 3);
  assert.equal(r.evidence, "no file edits in 3 turns");
});

test("stuckCheck resets idle turns on an edit outside .harness, not on a .harness edit", () => {
  const idle = { ...zero, idle_turns: 2 };
  assert.equal(stuckCheck(idle, [edit("src/a.ts")], opts).counters.idle_turns, 0);
  assert.equal(stuckCheck(idle, [edit("/w/.harness/state.md")], opts).counters.idle_turns, 3);
});

test("stuckCheck ignores idle turns off Implement and for subagent parents", () => {
  const idle = { ...zero, idle_turns: 5 };
  assert.deepEqual(stuckCheck(idle, [read], { ...opts, step: "plan" }).counters.idle_turns, 5);
  assert.equal(stuckCheck(idle, [read], { ...opts, step: "plan" }).evidence, null);
  const sub = stuckCheck(idle, [read], { ...opts, subagents: true });
  assert.equal(sub.counters.idle_turns, 5);
  assert.equal(sub.evidence, null);
});

test("stuckCheck intersects failing names across runs and reaches evidence at 3", () => {
  const r = stuckCheck(zero, [fail("a", "b"), fail("a"), fail("a", "c")], { ...opts, step: "plan" });
  assert.deepEqual(r.counters.fail_tests, ["a"]);
  assert.equal(r.counters.fail_runs, 3);
  assert.equal(r.evidence, "a failed 3 test runs in a row");
});

test("stuckCheck carries the streak across turns and names +N more", () => {
  const first = stuckCheck(zero, [fail("a", "b"), fail("a", "b")], { ...opts, step: "plan" });
  assert.equal(first.counters.fail_runs, 2);
  assert.equal(first.evidence, null);
  const second = stuckCheck(first.counters, [fail("b", "a")], { ...opts, step: "plan" });
  assert.equal(second.evidence, "a failed 3 test runs in a row (+1 more)");
});

test("stuckCheck restarts the streak on disjoint failures and resets on a pass", () => {
  const restarted = stuckCheck({ ...zero, fail_tests: ["a"], fail_runs: 2 }, [fail("z")], { ...opts, step: "plan" });
  assert.deepEqual(restarted.counters, { idle_turns: 0, fail_tests: ["z"], fail_runs: 1 });
  assert.equal(restarted.evidence, null);
  const passed = stuckCheck({ ...zero, fail_tests: ["a"], fail_runs: 2 }, [pass], { ...opts, step: "plan" });
  assert.deepEqual(passed.counters, zero);
});

test("stuckCheck names the failing test when both signals hold", () => {
  const r = stuckCheck({ ...zero, idle_turns: 2, fail_tests: ["a"], fail_runs: 2 }, [fail("a")], opts);
  assert.equal(r.evidence, "a failed 3 test runs in a row");
});

const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const midOpts = { now: NOW, mid: { fingerprint: "f1", changed: iso(NOW - 60_000) }, step: "implement", subagents: false };

test("midTurnCheck names a test failing in 3 runs, with +N more, and a passing last run is progress", () => {
  const r = midTurnCheck({ ...midOpts, runs: [["a", "b"], ["a"], ["b", "a"]], fingerprint: "f1" });
  assert.equal(r.evidence, "a failed 3 test runs in a row");
  assert.equal(r.progressed, false);
  const more = midTurnCheck({ ...midOpts, runs: [["a", "b"], ["a", "b"], ["b", "a"]], fingerprint: "f1" });
  assert.equal(more.evidence, "a failed 3 test runs in a row (+1 more)");
  const two = midTurnCheck({ ...midOpts, runs: [["a"], ["a"]], fingerprint: "f1" });
  assert.equal(two.evidence, null);
  const passed = midTurnCheck({ ...midOpts, runs: [["a"], ["a"], ["a"], []], fingerprint: "f1" });
  assert.equal(passed.evidence, null);
  assert.equal(passed.progressed, true);
});

test("midTurnCheck tracks the fingerprint: first sight, change, and unknown", () => {
  const first = midTurnCheck({ ...midOpts, runs: [], fingerprint: "f1", mid: { fingerprint: null, changed: null } });
  assert.deepEqual(first, { mid: { fingerprint: "f1", changed: iso(NOW) }, evidence: null, progressed: false });
  const edited = midTurnCheck({ ...midOpts, runs: [], fingerprint: "f2" });
  assert.deepEqual(edited, { mid: { fingerprint: "f2", changed: iso(NOW) }, evidence: null, progressed: true });
  const unknown = midTurnCheck({ ...midOpts, runs: [], fingerprint: null, mid: { fingerprint: "f1", changed: iso(NOW - MID_TURN_IDLE_MS) } });
  assert.deepEqual(unknown.mid, { fingerprint: "f1", changed: iso(NOW - MID_TURN_IDLE_MS) });
  assert.equal(unknown.evidence, null);
});

test("midTurnCheck flags no edits after 20 minutes on Implement only, not for subagent parents", () => {
  assert.equal(MID_TURN_IDLE_MS, 20 * 60_000);
  const old = { fingerprint: "f1", changed: iso(NOW - MID_TURN_IDLE_MS) };
  const idle = midTurnCheck({ ...midOpts, runs: [], fingerprint: "f1", mid: old });
  assert.equal(idle.evidence, "no file edits in 20 minutes");
  assert.deepEqual(idle.mid, old);
  const soon = midTurnCheck({ ...midOpts, runs: [], fingerprint: "f1", mid: { fingerprint: "f1", changed: iso(NOW - MID_TURN_IDLE_MS + 1) } });
  assert.equal(soon.evidence, null);
  assert.equal(midTurnCheck({ ...midOpts, runs: [], fingerprint: "f1", mid: old, step: "review" }).evidence, null);
  const sub = midTurnCheck({ ...midOpts, runs: [], fingerprint: "f1", mid: old, subagents: true });
  assert.equal(sub.evidence, null);
  assert.deepEqual(sub.mid, old);
});

test("midTurnCheck names the failing test before idleness", () => {
  const old = { fingerprint: "f1", changed: iso(NOW - 2 * MID_TURN_IDLE_MS) };
  const r = midTurnCheck({ ...midOpts, runs: [["a"], ["a"], ["a"]], fingerprint: "f1", mid: old });
  assert.equal(r.evidence, "a failed 3 test runs in a row");
});
