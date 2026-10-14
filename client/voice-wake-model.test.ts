import assert from "node:assert/strict";
import { test } from "node:test";
import { createWakeModel, EMBEDDING_WINDOW, MEL_WINDOW, SAMPLES_PER_FRAME, WAKE_COOLDOWN_MS, WAKE_THRESHOLD, type WakeModelRunners } from "./voice-wake-model";

function fakeRunners(over: { score?: () => number } = {}) {
  const embeddingCalls: Float32Array[][] = [];
  const classifierCalls: Float32Array[][] = [];
  const runners: WakeModelRunners = {
    melspectrogram: async () => [new Float32Array(32).fill(1)],
    embedding: async (window) => {
      embeddingCalls.push(window);
      return new Float32Array(96).fill(0.5);
    },
    classifier: async (window) => {
      classifierCalls.push(window);
      return (over.score ?? (() => 0))();
    },
  };
  return { runners, embeddingCalls, classifierCalls };
}

const FIRST_CLASSIFY_AT = MEL_WINDOW + EMBEDDING_WINDOW - 1;

test("accumulates mel frames into a full window before the first embedding", async () => {
  const f = fakeRunners();
  const model = createWakeModel(f.runners);
  for (let i = 0; i < MEL_WINDOW - 1; i++) await model.pushFrame(new Float32Array(SAMPLES_PER_FRAME));
  assert.equal(f.embeddingCalls.length, 0);
  await model.pushFrame(new Float32Array(SAMPLES_PER_FRAME));
  assert.equal(f.embeddingCalls.length, 1);
  assert.equal(f.embeddingCalls[0]!.length, MEL_WINDOW);
});

test("does not classify until a full window of embeddings has accumulated", async () => {
  const f = fakeRunners({ score: () => 1 });
  const model = createWakeModel(f.runners);
  for (let i = 0; i < FIRST_CLASSIFY_AT - 1; i++) await model.pushFrame(new Float32Array(SAMPLES_PER_FRAME));
  assert.equal(f.classifierCalls.length, 0);
  const fired = await model.pushFrame(new Float32Array(SAMPLES_PER_FRAME));
  assert.equal(f.classifierCalls.length, 1);
  assert.equal(f.classifierCalls[0]!.length, EMBEDDING_WINDOW);
  assert.equal(fired, true);
});

test("a score below threshold never fires", async () => {
  const f = fakeRunners({ score: () => WAKE_THRESHOLD - 0.01 });
  const model = createWakeModel(f.runners);
  let fired = false;
  for (let i = 0; i < FIRST_CLASSIFY_AT + 10; i++) fired ||= await model.pushFrame(new Float32Array(SAMPLES_PER_FRAME));
  assert.equal(fired, false);
});

test("a score at or above threshold fires wake once; the 2 s cooldown suppresses a second", async () => {
  let clock = 0;
  const f = fakeRunners({ score: () => WAKE_THRESHOLD });
  const model = createWakeModel(f.runners, () => clock);
  for (let i = 0; i < FIRST_CLASSIFY_AT - 1; i++) assert.equal(await model.pushFrame(new Float32Array(SAMPLES_PER_FRAME)), false);
  assert.equal(await model.pushFrame(new Float32Array(SAMPLES_PER_FRAME)), true);
  clock += WAKE_COOLDOWN_MS - 1;
  assert.equal(await model.pushFrame(new Float32Array(SAMPLES_PER_FRAME)), false);
  clock += 1;
  assert.equal(await model.pushFrame(new Float32Array(SAMPLES_PER_FRAME)), true);
});
