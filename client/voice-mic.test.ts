import assert from "node:assert/strict";
import { test } from "node:test";
import { canRecordHere, createVoiceMic, micErrorMessage, MIC_DENIED_MESSAGE, NO_MIC_MESSAGE } from "./voice-mic";

test("open() without navigator.mediaDevices says this device can't record", async () => {
  assert.equal(canRecordHere(), false);
  await assert.rejects(createVoiceMic().open(), { message: NO_MIC_MESSAGE });
});

test("a denied or blocked prompt reads as a permission message", () => {
  assert.equal(micErrorMessage(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" })), MIC_DENIED_MESSAGE);
  assert.equal(micErrorMessage({ name: "SecurityError" }), MIC_DENIED_MESSAGE);
  assert.match(micErrorMessage({ name: "NotFoundError" }), /No microphone/);
  assert.equal(micErrorMessage(new Error("odd")), "odd");
});

test("start() before open() still says the microphone is not open", () => {
  assert.throws(() => createVoiceMic().start(), /not open/);
});
