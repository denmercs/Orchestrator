import assert from "node:assert/strict";
import { test } from "node:test";
import { voiceSettings } from "../shared/settings";
import { MIC_DENIED_MESSAGE, NO_MIC_MESSAGE, PASEO_VOICE_LINE, PASEO_VOICE_TITLE } from "../shared/voice-lines";
import { drawerMicView, hasMicApi, ignoreMeView, PASEO_STOP_HINT, phoneReplyLine, voiceOffNotice, voiceStatusLine } from "./voice-mic-model";

test("hasMicApi is true only when mediaDevices.getUserMedia is a function", () => {
  assert.equal(hasMicApi(undefined), false);
  assert.equal(hasMicApi({}), false);
  assert.equal(hasMicApi({ mediaDevices: {} }), false);
  assert.equal(hasMicApi({ mediaDevices: { getUserMedia() {} } }), true);
});

test("with no mic API the drawer shows the Paseo voice view, not a dead-end card, and drops the no-mic error", () => {
  const view = drawerMicView({ hasMicApi: false, error: NO_MIC_MESSAGE });
  assert.deepEqual(view, { kind: "paseo-voice", title: PASEO_VOICE_TITLE, notice: PASEO_VOICE_LINE, error: null });
  assert.match(PASEO_VOICE_LINE, /turn on Paseo voice mode/i);
  assert.doesNotMatch(PASEO_VOICE_LINE, /can't record|can.t/i);
  assert.doesNotMatch(PASEO_VOICE_TITLE, /can't/i);
});

test("voiceOffNotice explains a profile of off, and is null otherwise", () => {
  assert.match(voiceOffNotice("off") ?? "", /off/i);
  assert.match(voiceOffNotice(" OFF ") ?? "", /Paseo default/);
  assert.equal(voiceOffNotice(""), null);
  assert.equal(voiceOffNotice("p_sonnet"), null);
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

test("a fresh install starts with the mic on: voice.micOff defaults to false", () => {
  assert.equal(voiceSettings.schema.parse({}).micOff, false);
  assert.deepEqual(ignoreMeView(false), { label: "Ignore me", on: false, status: null, action: "Turn Ignore me on" });
});

test("Ignore me is on when the mic is off, with a visible status saying you are being ignored", () => {
  const view = ignoreMeView(true);
  assert.equal(view.label, "Ignore me");
  assert.equal(view.on, true);
  assert.match(view.status ?? "", /ignoring you/i);
  assert.equal(view.action, "Turn Ignore me off");
});

test("voiceStatusLine labels the indirect voice signal as a best guess and never claims certainty", () => {
  assert.match(voiceStatusLine("on"), /Voice on/);
  assert.match(voiceStatusLine("off"), /Voice off/);
  for (const guess of ["on", "off"] as const) assert.match(voiceStatusLine(guess), /best guess/i);
  assert.doesNotMatch(voiceStatusLine("unknown"), /Voice (on|off)/);
  assert.match(voiceStatusLine("unknown"), /unknown/i);
  assert.match(PASEO_STOP_HINT, /Paseo's own (Stop|Mute)/i);
});
