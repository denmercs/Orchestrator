// Parity: a Claude transcript and the equivalent Paseo timeline items give the same ToolStep[].
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolSteps } from "../../../shared/exploration.ts";
import { transcriptSteps, shellBeforeEdit, calibration } from "./transcript.mjs";

const use = (id, name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id, content, isError = false) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
});

const entries = [
  use("t1", "Read", { file_path: "/r/a.ts" }),
  result("t1", "1\tconst a = 1;\n"),
  use("t2", "Grep", { pattern: "foo" }),
  result("t2", [{ type: "text", text: "/r/a.ts\n/r/b.ts" }]),
  use("t3", "Glob", { pattern: "**/*.ts" }),
  result("t3", "/r/c.ts"),
  use("t4", "Bash", { command: "ls" }),
  result("t4", "a b c"),
  use("t5", "Agent", { prompt: "go" }),
  result("t5", "sub result"),
  use("t6", "Read", { file_path: "/r/missing.ts" }),
  result("t6", "File does not exist.", true),
  use("t7", "Edit", { file_path: "/r/a.ts", old_string: "1", new_string: "2" }),
  result("t7", "ok"),
  use("t8", "MultiEdit", { file_path: "/r/b.ts", edits: [{ old_string: "x", new_string: "y" }] }),
  result("t8", "ok"),
  use("t9", "Write", { file_path: "/r/new.ts", content: "export {};\n" }),
  result("t9", "ok"),
];

const done = "completed";
const items = [
  { type: "tool_call", status: done, detail: { type: "read", filePath: "/r/a.ts", content: "1\tconst a = 1;\n" } },
  { type: "tool_call", status: done, detail: { type: "search", filePaths: [], content: "/r/a.ts\n/r/b.ts" } },
  { type: "tool_call", status: done, detail: { type: "search", filePaths: [], content: "/r/c.ts" } },
  { type: "tool_call", status: done, detail: { type: "shell", command: "ls", output: "a b c" } },
  { type: "tool_call", status: done, detail: { type: "sub_agent" } },
  { type: "tool_call", status: "failed", detail: { type: "read", filePath: "/r/missing.ts", content: "File does not exist." } },
  { type: "tool_call", status: done, detail: { type: "edit", filePath: "/r/a.ts", newString: "2" } },
  { type: "tool_call", status: done, detail: { type: "edit", filePath: "/r/b.ts", newString: "y" } },
  { type: "tool_call", status: done, detail: { type: "write", filePath: "/r/new.ts", content: "export {};\n" } },
];

test("transcriptSteps matches toolSteps on the equivalent timeline", () => {
  assert.deepEqual(transcriptSteps(entries), toolSteps(items));
});

test("shellBeforeEdit counts Bash calls and output chars up to the first code edit", () => {
  const log = [
    use("b1", "Bash", { command: "ls" }),
    result("b1", "a b c"),
    use("r1", "Read", { file_path: "/r/a.ts" }),
    result("r1", "x"),
    use("b2", "Bash", { command: "git log" }),
    result("b2", [{ type: "text", text: "12345" }]),
    use("e1", "Edit", { file_path: "/r/a.ts", old_string: "1", new_string: "2" }),
    result("e1", "ok"),
    use("b3", "Bash", { command: "npm test" }),
    result("b3", "after the edit"),
  ];
  assert.deepEqual(shellBeforeEdit(log, { step: "implement" }), { calls: 2, chars: 10 });
  assert.deepEqual(shellBeforeEdit([], { step: null }), { calls: 0, chars: 0 });
});

test("shellBeforeEdit follows the Plan stop rule and ignores harness edits otherwise", () => {
  const log = [
    use("b1", "Bash", { command: "ls" }),
    result("b1", "abc"),
    use("w1", "Write", { file_path: "/r/.harness/state.md", content: "## Plan\n\nDo it.\n" }),
    result("w1", "ok"),
    use("b2", "Bash", { command: "pwd" }),
    result("b2", "/r"),
  ];
  assert.deepEqual(shellBeforeEdit(log, { step: "plan" }), { calls: 1, chars: 3 });
  assert.deepEqual(shellBeforeEdit(log, { step: "implement" }), { calls: 2, chars: 5 });
});

// An assistant turn with usage (input, cache write, cache read, output); prompt = the first three summed.
const turn = (calls, [input, write, read, output]) => ({
  type: "assistant",
  message: {
    content: calls.map(([id, name, input]) => ({ type: "tool_use", id, name, input })),
    usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output },
  },
});
const results = (...pairs) => ({
  type: "user",
  message: { content: pairs.map(([id, text]) => ({ type: "tool_result", tool_use_id: id, content: text })) },
});

test("calibration pairs chars / 4 with billed prompt growth for read/search-only turns", () => {
  const log = [
    turn([["a1", "Read", { file_path: "/r/a.ts" }]], [10, 40, 50, 20]), // prompt 100, output 20
    results(["a1", "x".repeat(40)]),
    turn([["a2", "Bash", { command: "ls" }]], [5, 50, 77, 10]), // prompt 132: billed 132 - 100 - 20 = 12 vs 40 / 4
    results(["a2", "y".repeat(400)]), // Bash turn: no pair
    turn([["a3", "Grep", { pattern: "p" }], ["a3b", "Glob", { pattern: "*" }]], [5, 60, 100, 8]), // prompt 165
    results(["a3", "p".repeat(20)], ["a3b", "g".repeat(20)]),
    turn([["a4", "Read", { file_path: "/r/b.ts" }], ["a4b", "Bash", { command: "pwd" }]], [3, 0, 200, 6]), // prompt 203: billed 203 - 165 - 8 = 30 vs 40 / 4
    results(["a4", "r".repeat(40)], ["a4b", "/r"]), // mixed turn: no pair
    turn([], [1, 0, 300, 2]),
  ];
  assert.deepEqual(calibration(log), [
    { estimated: 10, billed: 12, ratio: 1.2 },
    { estimated: 10, billed: 30, ratio: 3 },
  ]);
});

test("transcriptSteps classifies Bash reads and searches like the live shell items", () => {
  const log = [
    use("s1", "Bash", { command: "sed -n 1,5p /r/a.ts" }),
    result("s1", "line one\n"),
    use("s2", "Bash", { command: "grep -rn foo /r" }),
    result("s2", "/r/a.ts:1:foo\n"),
    use("s3", "Bash", { command: "grep -rn bar /r" }),
    result("s3", "boom", true),
  ];
  const live = [
    { type: "tool_call", status: "completed", detail: { type: "shell", command: "sed -n 1,5p /r/a.ts", output: "line one\n" } },
    { type: "tool_call", status: "completed", detail: { type: "shell", command: "grep -rn foo /r", output: "/r/a.ts:1:foo\n" } },
    { type: "tool_call", status: "failed", detail: { type: "shell", command: "grep -rn bar /r", output: "boom" } },
  ];
  const steps = transcriptSteps(log);
  assert.deepEqual(steps, toolSteps(live));
  assert.deepEqual(steps.map((s) => s.kind), ["read", "search", "search"]);
  assert.equal(steps[2].chars, 0);
});
