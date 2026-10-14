import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_AUDIO_CHARS, MAX_HINTS, MAX_SPEAK_CHARS, transcribeVoice, voiceEvents, voiceSpeak, voiceWakeModel } from "./voice-rpc";

test("the transcribe RPC rejects oversized audio and too many hints", () => {
  const ok = { audio: "QUJD", hints: ["merge"] };
  assert.equal(transcribeVoice.input.safeParse(ok).success, true);
  assert.equal(transcribeVoice.input.safeParse({ ...ok, audio: "a".repeat(MAX_AUDIO_CHARS + 1) }).success, false);
  assert.equal(transcribeVoice.input.safeParse({ ...ok, hints: Array(MAX_HINTS + 1).fill("x") }).success, false);
  assert.equal(transcribeVoice.input.safeParse({ ...ok, hints: ["x".repeat(201)] }).success, false);
});

test("speak caps text at 400 and takes replyId", () => {
  const ok = { text: "x".repeat(MAX_SPEAK_CHARS), replyId: "r1" };
  assert.equal(MAX_SPEAK_CHARS, 400);
  assert.equal(voiceSpeak.name, "orchestration.voice.speak");
  assert.equal(voiceSpeak.input.safeParse(ok).success, true);
  assert.equal(voiceSpeak.input.safeParse({ ...ok, text: "x".repeat(401) }).success, false);
  assert.equal(voiceSpeak.input.safeParse({ text: "hi" }).success, false);
  assert.equal(voiceSpeak.output.safeParse({ audio: "UklGRg==", engine: "chatterbox" }).success, true);
  assert.equal(voiceSpeak.output.safeParse({ audio: "UklGRg==", engine: "kokoro" }).success, true);
  assert.equal(voiceSpeak.output.safeParse({ audio: "", engine: "loading" }).success, true);
  assert.equal(voiceSpeak.output.safeParse({ audio: "", engine: "other" }).success, false);
});

test("the wake model RPC is named orchestration.voice.wake-model and only accepts the three known models", () => {
  assert.equal(voiceWakeModel.name, "orchestration.voice.wake-model");
  assert.equal(voiceWakeModel.input.safeParse({ model: "melspectrogram" }).success, true);
  assert.equal(voiceWakeModel.input.safeParse({ model: "embedding" }).success, true);
  assert.equal(voiceWakeModel.input.safeParse({ model: "hey_jarvis" }).success, true);
  assert.equal(voiceWakeModel.input.safeParse({ model: "other" }).success, false);
});

test("voiceEvents takes { after } and returns { cursor, events, phoneActive }", () => {
  assert.equal(voiceEvents.name, "orchestration.voice.events");
  assert.equal(voiceEvents.input.safeParse({ after: 0 }).success, true);
  assert.equal(voiceEvents.input.safeParse({}).success, false);
  const out = { cursor: 2, events: [{ type: "reply", sessionId: "a", text: "done" }, { type: "notice", kind: "finished", sessionId: "a" }], phoneActive: false };
  assert.equal(voiceEvents.output.safeParse(out).success, true);
  assert.equal(voiceEvents.output.safeParse({ cursor: 0, events: [] }).success, false);
});
