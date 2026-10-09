import assert from "node:assert/strict";
import { test } from "node:test";
import { exploration, toolSteps, type ToolStep } from "./exploration";

const read = (path: string, chars = 0): ToolStep => ({ kind: "read", paths: [path], chars, text: null });
const search = (paths: string[], chars = 0): ToolStep => ({ kind: "search", paths, chars, text: null });
const edit = (path: string, text: string | null = null): ToolStep => ({ kind: "edit", paths: [path], chars: 0, text });
const write = (path: string, text: string | null = null): ToolStep => ({ kind: "write", paths: [path], chars: 0, text });

test("counts reads, searches, distinct read files and characters", () => {
  const result = exploration([read("a.ts", 10), read("a.ts", 5), read("b.ts", 20), search(["c.ts", "d.ts"], 7)], { step: "implement" });
  assert.deepEqual(result, { reads: 3, searches: 1, files: 2, chars: 42, edited: false });
});

test("stops at the first edit or write outside .harness/", () => {
  const result = exploration([read("a.ts", 10), edit("src/a.ts"), read("b.ts", 99), search([], 99)], { step: "implement" });
  assert.deepEqual(result, { reads: 1, searches: 0, files: 1, chars: 10, edited: true });
  assert.equal(exploration([read("a.ts"), write("src/new.ts"), read("b.ts")], { step: "implement" }).edited, true);
});

test("writes under .harness/ do not stop the count", () => {
  const result = exploration(
    [read("a.ts", 1), write("/repo/.harness/state.md"), edit(".harness/notes.md"), read("b.ts", 2)],
    { step: "implement" },
  );
  assert.deepEqual(result, { reads: 2, searches: 0, files: 2, chars: 3, edited: false });
});

test("the Plan step stops at the write that fills ## Plan", () => {
  const empty = "# S1\n\n## Plan\n\n## Cycles\n- [ ] one\n";
  const filled = "# S1\n\n## Plan\nDo the thing.\n\n## Cycles\n";
  const steps = [
    read("a.ts", 4),
    write("/repo/.harness/state.md", empty),
    read("b.ts", 6),
    edit("/repo/.harness/state.md", filled),
    read("c.ts", 100),
  ];
  assert.deepEqual(exploration(steps, { step: "plan" }), { reads: 2, searches: 0, files: 2, chars: 10, edited: true });
  // The same steps in another step stop at nothing: every write is under .harness/.
  assert.equal(exploration(steps, { step: "implement" }).edited, false);
});

test("the Plan step still stops at a code edit", () => {
  assert.deepEqual(exploration([read("a.ts", 1), edit("src/a.ts"), read("b.ts", 1)], { step: "plan" }), {
    reads: 1,
    searches: 0,
    files: 1,
    chars: 1,
    edited: true,
  });
});

test("an empty list counts nothing", () => {
  assert.deepEqual(exploration([], { step: null }), { reads: 0, searches: 0, files: 0, chars: 0, edited: false });
});

test("toolSteps maps the four detail types", () => {
  const items = [
    { type: "tool_call", status: "completed", detail: { type: "read", filePath: "a.ts", content: "hello" } },
    { type: "tool_call", status: "completed", detail: { type: "search", query: "x", filePaths: ["b.ts", "c.ts"], content: "abc" } },
    { type: "tool_call", status: "completed", detail: { type: "edit", filePath: "d.ts", newString: "new", unifiedDiff: "diff" } },
    { type: "tool_call", status: "completed", detail: { type: "edit", filePath: "e.ts", unifiedDiff: "diff" } },
    { type: "tool_call", status: "completed", detail: { type: "write", filePath: "f.md", content: "body" } },
  ];
  assert.deepEqual(toolSteps(items), [
    { kind: "read", paths: ["a.ts"], chars: 5, text: null },
    { kind: "search", paths: ["b.ts", "c.ts"], chars: 3, text: null },
    { kind: "edit", paths: ["d.ts"], chars: 0, text: "new" },
    { kind: "edit", paths: ["e.ts"], chars: 0, text: "diff" },
    { kind: "write", paths: ["f.md"], chars: 0, text: "body" },
  ]);
});

test("toolSteps counts chars only from completed calls and tolerates missing fields", () => {
  const items = [
    { type: "tool_call", status: "failed", detail: { type: "read", filePath: "a.ts", content: "hello" } },
    { type: "tool_call", status: "running", detail: { type: "search", query: "x" } },
  ];
  assert.deepEqual(toolSteps(items), [
    { kind: "read", paths: ["a.ts"], chars: 0, text: null },
    { kind: "search", paths: [], chars: 0, text: null },
  ]);
});

test("toolSteps drops shell, fetch, other detail types and non-tool items", () => {
  const items = [
    { type: "user_message" },
    { type: "assistant_message" },
    { type: "tool_call", status: "completed" },
    { type: "tool_call", status: "completed", detail: { type: "shell", command: "cat a.ts", output: "x" } },
    { type: "tool_call", status: "completed", detail: { type: "fetch", url: "https://x" } },
    { type: "tool_call", status: "completed", detail: { type: "sub_agent" } },
  ];
  assert.deepEqual(toolSteps(items), []);
});
