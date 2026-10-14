import assert from "node:assert/strict";
import { test } from "node:test";
import { JARVIS_VOICE_LINE, JARVIS_VOICE_TITLE, MIC_DENIED_MESSAGE, NO_MIC_MESSAGE } from "../shared/voice-lines";
import { drawerMicView, hasMicApi, phoneReplyLine } from "./voice-mic-model";

test("hasMicApi is true only when mediaDevices.getUserMedia is a function", () => {
  assert.equal(hasMicApi(undefined), false);
  assert.equal(hasMicApi({}), false);
  assert.equal(hasMicApi({ mediaDevices: {} }), false);
  assert.equal(hasMicApi({ mediaDevices: { getUserMedia() {} } }), true);
});

test("drawerMicView shows the Jarvis card when there is no mic API and drops the no-mic error", () => {
  assert.deepEqual(drawerMicView({ hasMicApi: false, error: NO_MIC_MESSAGE }), {
    kind: "jarvis",
    title: JARVIS_VOICE_TITLE,
    notice: JARVIS_VOICE_LINE,
    error: null,
  });
  assert.equal(JARVIS_VOICE_TITLE, "Talk through Jarvis");
  assert.equal(
    JARVIS_VOICE_LINE,
    "This device can't record from a plugin. Start a Jarvis session and turn on Paseo voice mode to talk. Replies show here.",
  );
});

test("drawerMicView keeps other errors with no mic API", () => {
  assert.equal(drawerMicView({ hasMicApi: false, error: "Couldn't send…" }).error, "Couldn't send…");
});

test("drawerMicView is the mic view with a mic API, keeping the error", () => {
  assert.deepEqual(drawerMicView({ hasMicApi: true, error: null }), { kind: "mic", error: null });
  assert.deepEqual(drawerMicView({ hasMicApi: true, error: MIC_DENIED_MESSAGE }), { kind: "mic", error: MIC_DENIED_MESSAGE });
});

test("phoneReplyLine is the spoken line of a reply for the target, else null", () => {
  assert.equal(phoneReplyLine({ type: "reply", sessionId: "a1", text: "All done." }, "a1"), "All done.");
  assert.equal(phoneReplyLine({ type: "reply", sessionId: "b2", text: "All done." }, "a1"), null);
  assert.equal(phoneReplyLine({ type: "reply", sessionId: "a1", text: "All done." }, null), null);
  assert.equal(phoneReplyLine({ type: "reply", sessionId: "a1", text: "All done." }, undefined), null);
  assert.equal(phoneReplyLine({ type: "wake" }, "a1"), null);
  assert.equal(phoneReplyLine({ type: "reply", sessionId: "a1", text: "" }, "a1"), null);
});
