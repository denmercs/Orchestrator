import assert from "node:assert/strict";
import { test } from "node:test";
import { canTarget, sessionName, splitSessions, voicePill, voiceSessions } from "./voice-pill-model";

const target = { id: "abcdef123456", title: "Build" };
const other = { id: "zzzzzzzz9999", title: "Docs" };

test("voicePill is hidden while voice is off", () => {
  assert.equal(voicePill(target, { mode: "asleep", session: { id: target.id, name: "Build" } }), null);
});

test("voicePill on the target shows the mode", () => {
  const pill = voicePill(target, { mode: "listening", session: { id: target.id, name: "Build" } });
  assert.equal(pill?.label, "Voice · listening");
  assert.ok(pill?.title);
});

test("voicePill on other sessions invites a tap", () => {
  assert.deepEqual(voicePill(other, { mode: "listening", session: { id: target.id, name: "Build" } }), {
    label: "Voice",
    title: "Tap to talk to this session",
  });
  assert.equal(voicePill(other, { mode: "waiting", session: null })?.label, "Voice");
});

test("sessionName falls back to the first 8 characters of the id", () => {
  assert.equal(sessionName(target), "Build");
  assert.equal(sessionName({ id: "abcdef123456" }), "abcdef12");
  assert.equal(sessionName({ id: "abcdef123456", title: "  " }), "abcdef12");
});

test("voiceSessions lists id and name", () => {
  assert.deepEqual(voiceSessions([target, { id: "abcdef999" }]), [
    { id: "abcdef123456", name: "Build" },
    { id: "abcdef999", name: "abcdef99" },
  ]);
});

test("Jarvis sessions and the Voice helper are not targets: left out of the list and split off as blocked", () => {
  const agents = [
    { id: "a1", title: "Build", provider: "claude" },
    { id: "j1", title: "Jarvis", provider: "jarvis" },
    { id: "h1", title: "Voice helper", provider: "claude", labels: { kind: "voice-helper" } },
  ];
  assert.deepEqual(agents.map(canTarget), [true, false, false]);
  assert.deepEqual(voiceSessions(agents), [{ id: "a1", name: "Build" }]);
  assert.deepEqual(splitSessions(agents).blocked, [
    { id: "j1", name: "Jarvis" },
    { id: "h1", name: "Voice helper" },
  ]);
});
