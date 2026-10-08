import assert from "node:assert/strict";
import { test } from "node:test";
import { logLine, mergeOlder, mergeTail, stepTitle, storySessions, type LogEntry, type LogPage } from "./session-log-model";

const entry = (seq: number, item: Record<string, unknown> = { type: "assistant_message", text: `reply ${seq}` }): LogEntry => ({
  item: item as LogEntry["item"],
  timestamp: "2026-10-07T12:00:00.000Z",
  seqStart: seq,
  seqEnd: seq,
});

const page = (seqs: number[], hasOlder: boolean, epoch = "e1"): LogPage => ({
  epoch,
  entries: seqs.map((seq) => entry(seq)),
  startCursor: seqs.length ? { epoch, seq: seqs[0] } : null,
  hasOlder,
});

test("a shell tool call reads as its command, with its output behind it", () => {
  const line = logLine(
    entry(4, {
      type: "tool_call",
      callId: "c1",
      name: "Bash",
      status: "failed",
      error: "exit 1",
      detail: { type: "shell", command: "npm test\n--watch", output: "1 failing" },
    }),
  );
  assert.equal(line?.kind, "tool");
  assert.equal(line?.title, "Bash · npm test");
  assert.equal(line?.body, "1 failing\n\nexit 1");
  assert.equal(line?.failed, true);
});

test("a prompt shows its first line and keeps the full text to expand", () => {
  const line = logLine(entry(1, { type: "user_message", text: "\nPlan S1.\n\nRead the story first." }));
  assert.equal(line?.kind, "prompt");
  assert.equal(line?.title, "Plan S1.");
  assert.equal(line?.body, "\nPlan S1.\n\nRead the story first.");
});

test("todos count what is done", () => {
  const line = logLine(
    entry(2, {
      type: "todo",
      items: [
        { text: "Write the test", completed: true },
        { text: "Make it pass", completed: false },
      ],
    }),
  );
  assert.equal(line?.title, "Tasks 1/2");
  assert.equal(line?.body, "✓ Write the test\n○ Make it pass");
});

test("plugin items and a compaction still loading have no line", () => {
  assert.equal(logLine(entry(3, { type: "plugin", id: "p", pluginId: "x", kind: "k", version: 1, data: null })), null);
  assert.equal(logLine(entry(3, { type: "compaction", status: "loading" })), null);
});

test("a refreshed tail replaces the newest entries and keeps older pages", () => {
  let state = mergeTail(null, page([5, 6, 7], true));
  state = mergeOlder(state, page([2, 3, 4], false));
  state = mergeTail(state, page([6, 7, 8], true));
  assert.deepEqual(
    state.entries.map((item) => item.seqStart),
    [2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(state.hasOlder, false);
  assert.deepEqual(state.olderCursor, { epoch: "e1", seq: 2 });
});

test("a new epoch starts the log over", () => {
  let state = mergeTail(null, page([5, 6], true));
  state = mergeOlder(state, page([3, 4], false));
  state = mergeTail(state, page([1, 2], false, "e2"));
  assert.deepEqual(
    state.entries.map((item) => item.seqStart),
    [1, 2],
  );
  assert.equal(state.epoch, "e2");
});

test("an older page from a stale epoch is ignored", () => {
  const state = mergeTail(null, page([5, 6], true));
  assert.equal(mergeOlder(state, page([3, 4], false, "old")), state);
});

test("a tail that skips past what the log holds starts over instead of leaving a hole", () => {
  let state = mergeTail(null, page([5, 6], true));
  state = mergeOlder(state, page([3, 4], false));
  state = mergeTail(state, page([9, 10], true));
  assert.deepEqual(
    state.entries.map((item) => item.seqStart),
    [9, 10],
  );
  assert.equal(state.hasOlder, true);
  assert.deepEqual(state.olderCursor, { epoch: "e1", seq: 9 });
});

test("a tail that follows straight on keeps the older pages", () => {
  const state = mergeTail(mergeTail(null, page([5, 6], false)), page([7, 8], true));
  assert.deepEqual(
    state.entries.map((item) => item.seqStart),
    [5, 6, 7, 8],
  );
  assert.equal(state.hasOlder, false);
});

const session = (id: string, workspaceId: string, labels: Record<string, string> = {}, title: string | null = null) => ({
  id,
  title,
  workspaceId,
  labels,
});

test("only the story's own workspace's sessions are listed once it has one", () => {
  const agents = [session("a1", "w1"), session("a2", "w2"), session("a3", "w1")];
  assert.deepEqual(
    storySessions(agents, "w1").map((agent) => agent.id),
    ["a1", "a3"],
  );
  assert.equal(storySessions(agents, "").length, 3);
});

test("a session is named for its step, with the round from round 2 on", () => {
  assert.equal(stepTitle(session("a", "w", { "loop-step": "plan", "loop-round": "1" })), "Plan");
  assert.equal(stepTitle(session("a", "w", { "loop-step": "review", "loop-round": "2" })), "Review 2");
  assert.equal(stepTitle(session("a", "w", { "loop-step": "fix" })), "Fix CI");
});

test("a session with an unknown step falls back to its title, then its id", () => {
  assert.equal(stepTitle(session("a", "w", { "loop-step": "deploy" }, "🔁 S1 · Deploy")), "🔁 S1 · Deploy");
  assert.equal(stepTitle(session("agent-7", "w", { "loop-step": "toString" })), "agent-7");
});

test("a completed compaction shows the tokens it compacted from, when the item has them", () => {
  assert.equal(logLine(entry(5, { type: "compaction", status: "completed", preTokens: 182_000 }))?.title, "Context compacted from 182k");
  assert.equal(logLine(entry(6, { type: "compaction", status: "completed" }))?.title, "Context compacted");
});
