import assert from "node:assert/strict";
import { test } from "node:test";
import { modelLabel, providerNote, sessionMap, type MapAgent } from "./session-map-model";

const agent = (id: string, extra: Partial<MapAgent> = {}): MapAgent => ({
  id,
  title: id,
  status: "idle",
  provider: "claude",
  model: "claude-sonnet-5-5",
  ...extra,
});
const step = (id: string, loopStep: string, extra: Partial<MapAgent> = {}) =>
  agent(id, { labels: { "loop-step": loopStep }, ...extra });

test("model ids read as short names, for either provider", () => {
  assert.equal(modelLabel("claude", "claude-sonnet-5-5"), "Sonnet 5.5");
  assert.equal(modelLabel("claude", "claude-haiku-5-5"), "Haiku 5.5");
  assert.equal(modelLabel("cursor", "composer-2.5"), "Composer 2.5");
  assert.equal(modelLabel("cursor", "claude-haiku-5-5"), "Haiku 5.5");
  assert.equal(modelLabel("cursor", undefined), "cursor");
});

test("the newest non-review session is main and its children are the workers", () => {
  const loop = [step("p", "plan"), step("i", "implement", { status: "running" })];
  const all = [
    ...loop,
    agent("w1", { status: "running", model: "claude-haiku-5-5", labels: { "paseo.parent-agent-id": "i" } }),
    agent("w2", { model: "claude-haiku-5-5", parentAgentId: "i" }),
    agent("other", { labels: { "paseo.parent-agent-id": "p" } }),
  ];
  const map = sessionMap(loop, all);
  assert.equal(map.main?.id, "i");
  assert.equal(map.main?.title, "Implement");
  assert.deepEqual(map.workers.map((w) => [w.id, w.state, w.model]), [["w1", "running", "Haiku 5.5"], ["w2", "done", "Haiku 5.5"]]);
});

test("the reviewer sleeps between reviews and counts its wake-ups", () => {
  const asleep = sessionMap([step("i", "implement"), step("r1", "review"), step("r2", "review")], []);
  assert.deepEqual(asleep.reviewer, { state: "asleep", wakes: 2, model: "Sonnet 5.5" });
  const awake = sessionMap([step("i", "implement"), step("r1", "review", { status: "running" })], []);
  assert.equal(awake.reviewer.state, "awake");
  assert.equal(sessionMap([step("i", "implement")], []).reviewer.model, null);
});

test("a story with no sessions has an empty map", () => {
  const map = sessionMap([], []);
  assert.equal(map.main, null);
  assert.equal(map.mixed, false);
  assert.equal(providerNote(map), "");
});

test("one provider reads plain; Claude and Cursor together warn", () => {
  const cursorOnly = sessionMap([step("i", "implement", { provider: "cursor", model: "composer-2.5" })], []);
  assert.equal(providerNote(cursorOnly), "Cursor only");
  const mixed = sessionMap(
    [step("i", "implement", { provider: "cursor", model: "composer-2.5" }), step("r", "review")],
    [],
  );
  assert.equal(mixed.mixed, true);
  assert.equal(providerNote(mixed), "Mixed providers: Cursor + Claude. A run should stay on one.");
});
