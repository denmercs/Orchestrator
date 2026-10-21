import assert from "node:assert/strict";
import { test } from "node:test";
import { canTarget, sessionName, splitSessions, voicePill, voicePillMenu, voiceSessions } from "./voice-pill-model";

const target = { id: "abcdef123456", title: "Build" };
const other = { id: "zzzzzzzz9999", title: "Docs" };

test("voicePill shows on every session, in every state: off with the mic off, the mode with it on", () => {
  const session = { id: target.id, name: "Build" };
  assert.equal(voicePill(target, { mode: "asleep", session, micOn: false }).label, "Voice · off");
  assert.equal(voicePill(target, { mode: "asleep", session, micOn: true }).label, "Voice · asleep");
  assert.equal(voicePill(target, { mode: "listening", session, micOn: true }).label, "Voice · listening");
  assert.equal(voicePill(target, { mode: "speaking", session, micOn: true }).label, "Voice · speaking");
});

test("voicePill on the target shows the mode in its title too", () => {
  const pill = voicePill(target, { mode: "listening", session: { id: target.id, name: "Build" }, micOn: true });
  assert.equal(pill.label, "Voice · listening");
  assert.ok(pill.title);
});

test("voicePill on other sessions always invites a tap, in every mode and mic state", () => {
  assert.deepEqual(voicePill(other, { mode: "listening", session: { id: target.id, name: "Build" }, micOn: true }), {
    label: "Voice · listening",
    title: "Tap to talk to this session",
  });
  assert.equal(voicePill(other, { mode: "waiting", session: null, micOn: true }).title, "Tap to talk to this session");
  assert.equal(voicePill(other, { mode: "asleep", session: null, micOn: false }).title, "Tap to talk to this session");
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

test("voicePillMenu offers talk and the four speak modes, checking the current one", () => {
  const items = voicePillMenu({ talk: true, speak: "short" });
  assert.deepEqual(
    items.map((e) => (e.kind === "separator" ? "-" : e.id)),
    ["talk", "-", "speak-off", "speak-short", "speak-medium", "speak-full"],
  );
  const checked = items.filter((e) => e.kind === "item" && e.icon === "Check").map((e) => e.kind === "item" && e.id);
  assert.deepEqual(checked, ["speak-short"]);
});

test("voicePillMenu leaves out talk when the session can't be a target, and the speak items when it has a parent", () => {
  assert.deepEqual(voicePillMenu({ talk: false, speak: "off" }).map((e) => e.id), ["speak-off", "speak-short", "speak-medium", "speak-full"]);
  assert.deepEqual(voicePillMenu({ talk: true, speak: null }).map((e) => e.id), ["talk"]);
  assert.deepEqual(voicePillMenu({ talk: false, speak: null }), []);
});

test("voicePillMenu items carry what they do: talk picks, a speak item sets its mode", () => {
  const items = voicePillMenu({ talk: true, speak: "off" });
  const actions = items.flatMap((e) => (e.kind === "item" ? [e.action] : []));
  assert.deepEqual(actions, [
    { kind: "talk" },
    { kind: "speak", mode: "off" },
    { kind: "speak", mode: "short" },
    { kind: "speak", mode: "medium" },
    { kind: "speak", mode: "full" },
  ]);
});

test("voicePill adds the speak mode to the label and title once replies are spoken", () => {
  const state = { mode: "listening" as const, session: { id: target.id, name: "Build" }, micOn: true };
  assert.equal(voicePill(target, state, "off").label, "Voice · listening");
  const pill = voicePill(target, state, "medium");
  assert.equal(pill.label, "Voice · listening · speak medium");
  assert.match(pill.title, /Replies are spoken \(medium\)/);
});

test("voicePill with no voice runner is just the speak pill", () => {
  assert.equal(voicePill(target, null, "off").label, "Speak replies");
  assert.equal(voicePill(target, null, "full").label, "Speak · full");
});
