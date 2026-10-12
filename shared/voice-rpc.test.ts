import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_AUDIO_CHARS, MAX_HINTS, transcribeVoice } from "./voice-rpc";

test("the transcribe RPC rejects oversized audio and too many hints", () => {
  const ok = { audio: "QUJD", hints: ["merge"] };
  assert.equal(transcribeVoice.input.safeParse(ok).success, true);
  assert.equal(transcribeVoice.input.safeParse({ ...ok, audio: "a".repeat(MAX_AUDIO_CHARS + 1) }).success, false);
  assert.equal(transcribeVoice.input.safeParse({ ...ok, hints: Array(MAX_HINTS + 1).fill("x") }).success, false);
  assert.equal(transcribeVoice.input.safeParse({ ...ok, hints: ["x".repeat(201)] }).success, false);
});
