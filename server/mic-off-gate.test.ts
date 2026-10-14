import assert from "node:assert/strict";
import { test } from "node:test";
import { createMicOffGate, MIC_OFF_MAX_MISSES } from "./mic-off-gate";

const ready = (micOff: boolean) => ({ status: "ready", values: { micOff } }) as const;

test("before the first read resolves the gate fails closed; a ready read settles it", async () => {
  const gate = createMicOffGate(async () => ready(true));
  assert.equal(await gate.muted(), true);
  assert.equal(gate.unreadable(), false);
  const open = createMicOffGate(async () => ready(false));
  assert.equal(await open.muted(), false);
});

test("an invalid settings read fails open and is reported as unreadable", async () => {
  const gate = createMicOffGate(async () => ({ status: "invalid" }));
  assert.equal(await gate.muted(), false);
  assert.equal(gate.unreadable(), true);
});

test("a read that keeps rejecting stays closed for a short window, then fails open", async () => {
  const gate = createMicOffGate(async () => Promise.reject(new Error("rpc down")));
  for (let i = 0; i < MIC_OFF_MAX_MISSES - 1; i++) assert.equal(await gate.muted(), true, `miss ${i + 1}`);
  assert.equal(await gate.muted(), false);
  assert.equal(gate.unreadable(), true);
});

test("a loading state counts as no answer yet, and the same cap applies", async () => {
  const gate = createMicOffGate(async () => ({ status: "loading" }));
  assert.equal(await gate.muted(), true);
  for (let i = 0; i < MIC_OFF_MAX_MISSES; i++) await gate.muted();
  assert.equal(await gate.muted(), false);
});

test("a later ready state repairs an unreadable one, and a loading state keeps the last known value", async () => {
  const gate = createMicOffGate(async () => ({ status: "invalid" }));
  await gate.muted();
  gate.sync(ready(true));
  assert.equal(gate.unreadable(), false);
  assert.equal(await gate.muted(), true);
  gate.sync({ status: "loading" });
  assert.equal(await gate.muted(), true);
  gate.sync({ status: "invalid" });
  assert.equal(await gate.muted(), false);
  assert.equal(gate.unreadable(), true);
});

// The panel and the server read the same saved setting: what the drawer shows as Ignore me is what the server drops.
import { createVoiceRunner } from "../client/voice-runner";
import { createVoicePrefs } from "../client/voice-prefs";

test("the panel's Ignore me and the server's muted state agree for ready, invalid and rejecting settings", async () => {
  const cases = [
    { answer: () => ({ status: "ready", revision: "1", values: { micOff: true } }), ignoring: true, unreadable: false },
    { answer: () => ({ status: "ready", revision: "1", values: { micOff: false } }), ignoring: false, unreadable: false },
    { answer: () => ({ status: "invalid", revision: "1", error: "corrupt" }), ignoring: false, unreadable: true },
    { answer: () => Promise.reject(new Error("rpc down")), ignoring: false, unreadable: true },
  ];
  for (const c of cases) {
    const rpc = (async () => c.answer()) as never;
    const runner = createVoiceRunner({ link: { say: async () => {}, interrupt: async () => {} }, prefs: createVoicePrefs(rpc) });
    await runner.start();
    const gate = createMicOffGate(async () => c.answer() as never);
    let muted = await gate.muted();
    for (let i = 0; i < MIC_OFF_MAX_MISSES && muted && !c.ignoring; i++) muted = await gate.muted();
    assert.equal(runner.getState().ignoring, c.ignoring);
    assert.equal(muted, c.ignoring);
    assert.equal(runner.getState().settingsUnreadable, c.unreadable);
    assert.equal(gate.unreadable(), c.unreadable);
  }
});
