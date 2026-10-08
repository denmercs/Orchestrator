import assert from "node:assert/strict";
import { test } from "node:test";
import { freshCompactor, handoffAsk, keepList, nativeCompactor, type FreshPort, type FreshSession } from "./compactor";

test("keepList: a plain session keeps the base list", () => {
  assert.deepEqual(keepList({}), [".harness/state.md", "files changed this session", "failing tests and their output"]);
});

test("keepList: a loop agent adds its step and story", () => {
  assert.deepEqual(keepList({ "loop-step": "implement", "loop-story": "S2" }), [
    ".harness/state.md",
    "files changed this session",
    "failing tests and their output",
    "step implement",
    "story S2",
  ]);
});

test("nativeCompactor sends /compact with the keep-list to the same agent", async () => {
  const sent: [string, string][] = [];
  const compactor = nativeCompactor(async (agentId, text) => {
    sent.push([agentId, text]);
  });

  const result = await compactor.compact("a1", keepList({ "loop-step": "implement", "loop-story": "S2" }));

  assert.deepEqual(sent, [
    [
      "a1",
      "/compact Keep: .harness/state.md, files changed this session, failing tests and their output, step implement, story S2.",
    ],
  ]);
  assert.deepEqual(result, { kind: "native", agentId: "a1" });
});

// A fake fresh port: one session per test, and every call recorded in order.
function fakeFresh(session: FreshSession | null, options: { loopPrompt?: string | null; failCreate?: boolean } = {}) {
  const calls: unknown[][] = [];
  const port: FreshPort = {
    session: async (id) => {
      calls.push(["session", id]);
      return session;
    },
    handoff: async (id, cwd, text) => {
      calls.push(["handoff", id, cwd, text]);
    },
    create: async (input) => {
      calls.push(["create", input]);
      if (options.failCreate) throw new Error("create failed");
      return "a2";
    },
    archive: async (id) => {
      calls.push(["archive", id]);
    },
    loopPrompt: async (labels) => {
      calls.push(["loopPrompt", labels]);
      return options.loopPrompt ?? null;
    },
    handOver: async (labels, from, to) => {
      calls.push(["handOver", labels, from, to]);
    },
  };
  return { port, calls };
}

const session = (labels: Record<string, string> = {}, running = false): FreshSession => ({
  workspaceId: "ws1",
  cwd: "/repo",
  config: { provider: "codex/gpt-5", modeId: "full", thinkingOptionId: "high" },
  title: "Fix the meter",
  labels,
  running,
});

test("freshCompactor writes a handoff, creates one agent in the same workspace with the same config and labels + context-from, then archives the old one", async () => {
  const { port, calls } = fakeFresh(session({ team: "core" }));
  const list = keepList({});

  const result = await freshCompactor(port).compact("a1", list);

  assert.deepEqual(result, { kind: "fresh", agentId: "a2" });
  assert.deepEqual(calls, [
    ["session", "a1"],
    ["handoff", "a1", "/repo", handoffAsk(list)],
    [
      "create",
      {
        workspaceId: "ws1",
        cwd: "/repo",
        config: { provider: "codex/gpt-5", modeId: "full", thinkingOptionId: "high" },
        title: "Fix the meter · fresh",
        labels: { team: "core", "context-from": "a1" },
        prompt: "Continue from `.harness/handoff.md`. An earlier session ran out of context and wrote it for you.",
      },
    ],
    ["archive", "a1"],
  ]);
  assert.match(handoffAsk(list), /\.harness\/handoff\.md/);
  assert.match(handoffAsk(list), /Keep: \.harness\/state\.md, files changed this session, failing tests and their output\./);
});

test("a loop agent gets the step prompt plus resume, no handoff turn, and the story's agent moves", async () => {
  const labels = { kind: "initiative-loop", "loop-step": "implement", "loop-story": "S3", "loop-round": "1" };
  const { port, calls } = fakeFresh(session(labels), { loopPrompt: "Implement S3.\n\nResume from `.harness/state.md`." });

  const result = await freshCompactor(port).compact("a1", keepList(labels));

  assert.deepEqual(result, { kind: "fresh", agentId: "a2" });
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["session", "loopPrompt", "create", "handOver", "archive"],
  );
  const created = calls[2][1] as { prompt: string; labels: Record<string, string> };
  assert.equal(created.prompt, "Implement S3.\n\nResume from `.harness/state.md`.");
  assert.deepEqual(created.labels, { ...labels, "context-from": "a1" });
  assert.deepEqual(calls[3], ["handOver", labels, "a1", "a2"]);
});

test("a running session is refused", async () => {
  const { port, calls } = fakeFresh(session({}, true));

  await assert.rejects(freshCompactor(port).compact("a1", keepList({})), /Wait for the turn to end, then start fresh\./);
  assert.deepEqual(calls, [["session", "a1"]]);
});

test("a failed create archives nothing", async () => {
  const { port, calls } = fakeFresh(session(), { failCreate: true });

  await assert.rejects(freshCompactor(port).compact("a1", keepList({})), /create failed/);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["session", "handoff", "create"],
  );
});
