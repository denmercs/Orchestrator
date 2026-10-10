import assert from "node:assert/strict";
import { test } from "node:test";
import { stuckCheck, testRuns, type StuckCounters } from "./stuck";
import type { ToolItem } from "./exploration";

const shell = (command: string, output: string): ToolItem => ({ type: "tool_call", status: "completed", detail: { type: "shell", command, output } });
const brief = (output: string) => shell(".harness/bin/brief npm test", `brief: exit 1 · 9 lines · full log .harness/logs/x.log\n${output}`);

test("testRuns reads failing names from TAP not ok lines", () => {
  const output = ["not ok 3 - parses a turn", "  ---", "  error: boom", "  ...", "# tests 5", "# pass 4", "# fail 1"].join("\n");
  assert.deepEqual(testRuns([brief(output)]), [["parses a turn"]]);
});

test("testRuns reads failing names from the failing tests block", () => {
  const output = ["✖ failing tests:", "", "test at a.test.ts:1:1", "✖ first one (1.2ms)", "  AssertionError: x", "✖ second one (0.3ms)", "ℹ tests 4", "ℹ fail 2"].join("\n");
  assert.deepEqual(testRuns([brief(output)]), [["first one", "second one"]]);
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
