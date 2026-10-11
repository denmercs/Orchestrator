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

test("toolSteps drops fetch, other detail types, non-tool items and shell that classifies as other", () => {
  const items = [
    { type: "user_message" },
    { type: "assistant_message" },
    { type: "tool_call", status: "completed" },
    { type: "tool_call", status: "completed", detail: { type: "shell", command: "git status", output: "clean" } },
    { type: "tool_call", status: "completed", detail: { type: "shell", output: "no command" } },
    { type: "tool_call", status: "completed", detail: { type: "fetch", url: "https://x" } },
    { type: "tool_call", status: "completed", detail: { type: "sub_agent" } },
  ];
  assert.deepEqual(toolSteps(items), []);
});

const shell = (command: string, extra: Record<string, unknown> = {}, status = "completed") => ({
  type: "tool_call",
  status,
  detail: { type: "shell", command, ...extra },
});

test("a completed shell item puts the whole output length on its first read or search step", () => {
  const items = [shell("cd /repo; cat a.ts; grep -n x b.ts; git status", { output: "12345678" })];
  assert.deepEqual(toolSteps(items), [
    { kind: "read", paths: ["/repo/a.ts"], chars: 8, text: null },
    { kind: "search", paths: [], chars: 0, text: null },
  ]);
  assert.deepEqual(toolSteps([shell("grep -rn x src; cat a.ts", { output: "123" })]).map((step) => step.chars), [3, 0]);
});

test("a shell item that is not completed has 0 chars", () => {
  assert.deepEqual(toolSteps([shell("cat a.ts", { output: "hello" }, "failed"), shell("ls", { output: "hello" }, "running")]), [
    { kind: "read", paths: ["a.ts"], chars: 0, text: null },
    { kind: "search", paths: [], chars: 0, text: null },
  ]);
});

test("a shell item with no read or search step drops its output", () => {
  assert.deepEqual(toolSteps([shell("sed -i '' s/a/b/ src/a.ts", { output: "hello" })]), [
    { kind: "edit", paths: ["src/a.ts"], chars: 0, text: null },
  ]);
});

test("a shell-only sed -i sets edited", () => {
  const steps = toolSteps([shell("cat a.ts", { output: "abc" }), shell("sed -i s/a/b/ src/a.ts"), shell("cat b.ts", { output: "zzzz" })]);
  assert.deepEqual(exploration(steps, { step: "implement" }), { reads: 1, searches: 0, files: 1, chars: 3, edited: true });
});

test("shell reads add to reads and files, with relative paths resolved against cwd", () => {
  const steps = toolSteps([
    { type: "tool_call", status: "completed", detail: { type: "read", filePath: "/repo/a.ts", content: "ab" } },
    shell("cat a.ts", { cwd: "/repo", output: "abc" }),
    shell("head -5 b.ts", { cwd: "/repo", output: "abcd" }),
  ]);
  assert.deepEqual(exploration(steps, { step: "implement" }), { reads: 3, searches: 0, files: 2, chars: 9, edited: false });
});

test("a shell .harness/state.md heredoc that fills ## Plan ends the Plan count", () => {
  const body = "# S1\n\n## Plan\nDo the thing.\n\n## Cycles\n";
  const steps = toolSteps([
    shell("cat a.ts", { cwd: "/repo", output: "abcd" }),
    shell(`cat > .harness/state.md <<'EOF'\n${body}EOF`, { cwd: "/repo" }),
    shell("cat b.ts", { cwd: "/repo", output: "zzzz" }),
  ]);
  assert.deepEqual(exploration(steps, { step: "plan" }), { reads: 1, searches: 0, files: 1, chars: 4, edited: true });
  assert.equal(exploration(steps, { step: "implement" }).edited, false);
});
