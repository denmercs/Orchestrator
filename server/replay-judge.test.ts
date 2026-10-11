import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ask } from "./claude-cli";
import { haikuJudge } from "./replay-judge";

const recorded = ["missing test for parse", "uses any in the loader"];
const replay = ["parse has no test", "unrelated naming nit", "loader casts to any"];

function fakeAsk(text: string, costUsd = 0.001) {
  const calls: { system: string; prompt: string }[] = [];
  const ask: Ask = async (system, prompt) => {
    calls.push({ system, prompt });
    return { text, costUsd };
  };
  return { ask, calls };
}

test("asks once with both finding lists", async () => {
  const { ask, calls } = fakeAsk('{"matches":[],"new":[0,1,2]}');
  await haikuJudge(ask)(recorded, replay);
  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /JSON/);
  for (const f of [...recorded, ...replay]) assert.ok(calls[0].prompt.includes(f), f);
});

test("returns the matches and the cost", async () => {
  const { ask } = fakeAsk('```json\n{"matches":[[0,0],[2,1]],"new":[1]}\n```', 0.0045);
  const result = await haikuJudge(ask)(recorded, replay);
  assert.deepEqual(result.matches, [[0, 0], [2, 1]]);
  assert.equal(result.costUsd, 0.0045);
});

test("an unusable reply still reports its cost, with matches null", async () => {
  for (const text of ["not json", '{"matches":[[9,0]],"new":[]}']) {
    const { ask } = fakeAsk(text, 0.0015);
    const result = await haikuJudge(ask)(recorded, replay);
    assert.equal(result.matches, null);
    assert.equal(result.costUsd, 0.0015);
    assert.equal(result.reply, text);
  }
});

test("a usable reply is not echoed back", async () => {
  const { ask } = fakeAsk('{"matches":[],"new":[0,1,2]}');
  assert.equal((await haikuJudge(ask)(recorded, replay)).reply, undefined);
});

test("a failed ask propagates", async () => {
  const ask: Ask = async () => {
    throw new Error("could not run the claude CLI");
  };
  await assert.rejects(haikuJudge(ask)(recorded, replay), /claude CLI/);
});
