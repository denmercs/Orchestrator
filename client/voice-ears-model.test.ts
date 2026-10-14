import assert from "node:assert/strict";
import { test } from "node:test";
import { createEarsModel, encodeWav, MAX_UTTERANCE_MS, SAMPLE_RATE, SILENCE_END_MS, type WakeDetector } from "./voice-ears-model";

const FRAME_MS = 80;
const FRAME_SAMPLES = Math.round((SAMPLE_RATE * FRAME_MS) / 1000);
const quiet = () => new Float32Array(FRAME_SAMPLES);
const loud = () => new Float32Array(FRAME_SAMPLES).fill(0.3);

function fakeWake(score: boolean) {
  const wake: WakeDetector = { pushFrame: async () => score };
  return wake;
}

test("asleep, loud frames and a wake score give only wake", async () => {
  const ears = createEarsModel(fakeWake(true));
  assert.deepEqual(await ears.pushFrame(loud()), { type: "wake" });
  assert.deepEqual(await ears.pushFrame(quiet()), { type: "wake" });
});

test("asleep, a low wake score gives nothing", async () => {
  const ears = createEarsModel(fakeWake(false));
  assert.equal(await ears.pushFrame(loud()), null);
});

test("awake, quiet frames give nothing", async () => {
  const ears = createEarsModel(fakeWake(false));
  ears.setAwake(true);
  assert.equal(await ears.pushFrame(quiet()), null);
  assert.equal(await ears.pushFrame(quiet()), null);
});

test("awake, speech gives speechStart then one utterance after 800 ms of silence, including the pre-roll", async () => {
  const ears = createEarsModel(fakeWake(false));
  ears.setAwake(true);
  for (let i = 0; i < 2; i++) assert.equal(await ears.pushFrame(quiet()), null);
  assert.deepEqual(await ears.pushFrame(loud()), { type: "speechStart" });
  assert.equal(await ears.pushFrame(loud()), null);
  const silenceFrames = Math.ceil(SILENCE_END_MS / FRAME_MS);
  let utterance: { type: string; pcm: Int16Array } | null = null;
  for (let i = 0; i < silenceFrames; i++) {
    const event = (await ears.pushFrame(quiet())) as { type: string; pcm: Int16Array } | null;
    if (event) utterance = event;
  }
  assert.equal(utterance?.type, "utterance");
  const expectedFrames = 2 + 1 + 1 + silenceFrames;
  assert.equal(utterance!.pcm.length, expectedFrames * FRAME_SAMPLES);
});

test("a 30 s utterance ends on the cap even with no silence", async () => {
  const ears = createEarsModel(fakeWake(false));
  ears.setAwake(true);
  assert.deepEqual(await ears.pushFrame(loud()), { type: "speechStart" });
  const framesTotal = Math.ceil(MAX_UTTERANCE_MS / FRAME_MS);
  let utterance: { type: string } | null = null;
  for (let i = 1; i < framesTotal; i++) {
    const event = await ears.pushFrame(loud());
    if (event) utterance = event as { type: string };
  }
  assert.equal(utterance?.type, "utterance");
});

test("paused emits nothing, asleep or awake", async () => {
  const ears = createEarsModel(fakeWake(true));
  ears.setPaused(true);
  assert.equal(await ears.pushFrame(loud()), null);
  ears.setAwake(true);
  assert.equal(await ears.pushFrame(loud()), null);
});

test("encodeWav writes a standard 16-bit mono header and the right data length", () => {
  const pcm = new Int16Array([0, 100, -100, 32767, -32768]);
  const base64 = encodeWav(pcm);
  const bytes = Buffer.from(base64, "base64");
  assert.equal(bytes.length, 44 + pcm.length * 2);
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  assert.equal(bytes.toString("ascii", 12, 16), "fmt ");
  assert.equal(bytes.readUInt16LE(22), 1);
  assert.equal(bytes.readUInt32LE(24), SAMPLE_RATE);
  assert.equal(bytes.readUInt16LE(34), 16);
  assert.equal(bytes.toString("ascii", 36, 40), "data");
  assert.equal(bytes.readUInt32LE(40), pcm.length * 2);
  assert.equal(bytes.readInt16LE(44), 0);
  assert.equal(bytes.readInt16LE(44 + 2 * 3), 32767);
});
