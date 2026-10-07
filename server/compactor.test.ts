import assert from "node:assert/strict";
import { test } from "node:test";
import { keepList, nativeCompactor } from "./compactor";

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
