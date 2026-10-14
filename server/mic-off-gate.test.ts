import assert from "node:assert/strict";
import { test } from "node:test";
import { createMicOffGate, MIC_OFF_RETRY_MS } from "./mic-off-gate";

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

const clockGate = (read: () => Promise<{ status: string; values?: { micOff?: boolean } }>) => {
  let t = 1_000;
  const gate = createMicOffGate(read, () => t);
  return { gate, advance: (ms: number) => void (t += ms) };
};

test("a read that keeps rejecting never fails open: speech stays dropped, and rereads back off", async () => {
  let reads = 0;
  const { gate, advance } = clockGate(async () => (reads++, Promise.reject(new Error("rpc down"))));
  for (let i = 0; i < 10; i++) assert.equal(await gate.muted(), true);
  assert.equal(reads, 1, "burst of calls inside the backoff reads once");
  advance(MIC_OFF_RETRY_MS * 4);
  assert.equal(await gate.muted(), true);
  assert.equal(reads, 2, "rereads after the backoff");
  assert.equal(gate.unreadable(), false);
  assert.equal(gate.checking(), true);
});

test("after failures the gate recovers when a read finally answers", async () => {
  let up = false;
  const { gate, advance } = clockGate(async () => (up ? ready(false) : Promise.reject(new Error("down"))));
  assert.equal(await gate.muted(), true);
  up = true;
  advance(MIC_OFF_RETRY_MS * 8);
  assert.equal(await gate.muted(), false);
  assert.equal(gate.checking(), false);
});

test("a loading state counts as no answer yet and stays closed", async () => {
  const { gate } = clockGate(async () => ({ status: "loading" }));
  assert.equal(await gate.muted(), true);
  assert.equal(gate.checking(), true);
});

test("ready ON then an invalid state keeps ignoring (the last value read), and says unreadable", async () => {
  const gate = createMicOffGate(async () => ready(true));
  await gate.muted();
  gate.sync({ status: "invalid" });
  assert.equal(await gate.muted(), true);
  assert.equal(gate.unreadable(), true);
  assert.equal(gate.lastKnown(), true);
});

test("ready ON then many failed reads and loading states never flip it off", async () => {
  const gate = createMicOffGate(() => Promise.reject(new Error("down")));
  gate.sync(ready(true));
  for (let i = 0; i < 10; i++) {
    gate.sync({ status: "loading" });
    assert.equal(await gate.muted(), true);
  }
});

test("a later ready state repairs an unreadable one", async () => {
  const gate = createMicOffGate(async () => ({ status: "invalid" }));
  await gate.muted();
  assert.equal(gate.unreadable(), true);
  gate.sync(ready(true));
  assert.equal(gate.unreadable(), false);
  assert.equal(await gate.muted(), true);
});

// The panel and the server read the same saved setting: what the drawer shows as Ignore me is what the server drops.
import { createVoiceRunner } from "../client/voice-runner";
import { createVoicePrefs } from "../client/voice-prefs";

test("the panel's Ignore me and the server's muted state agree for ready and invalid settings", async () => {
  const cases = [
    { answer: () => ({ status: "ready", revision: "1", values: { micOff: true } }), ignoring: true, unreadable: false },
    { answer: () => ({ status: "ready", revision: "1", values: { micOff: false } }), ignoring: false, unreadable: false },
    { answer: () => ({ status: "invalid", revision: "1", error: "corrupt" }), ignoring: false, unreadable: true },
  ];
  for (const c of cases) {
    const rpc = (async () => c.answer()) as never;
    const runner = createVoiceRunner({ link: { say: async () => {}, interrupt: async () => {} }, prefs: createVoicePrefs(rpc) });
    await runner.start();
    const gate = createMicOffGate(async () => c.answer() as never);
    const muted = await gate.muted();
    assert.equal(runner.getState().ignoring, c.ignoring);
    assert.equal(muted, c.ignoring);
    assert.equal(runner.getState().settingsUnreadable, c.unreadable);
    assert.equal(gate.unreadable(), c.unreadable);
  }
});

test("a rejecting setting: the server holds speech and the panel says it is checking, not that you are heard", async () => {
  const rpc = (async () => Promise.reject(new Error("rpc down"))) as never;
  const runner = createVoiceRunner({ link: { say: async () => {}, interrupt: async () => {} }, prefs: createVoicePrefs(rpc), clock: { setTimeout: () => 0, clearTimeout: () => {} } });
  await runner.start();
  const gate = createMicOffGate(() => Promise.reject(new Error("rpc down")));
  assert.equal(await gate.muted(), true);
  assert.equal(runner.getState().settingsChecking, true);
  assert.equal(gate.checking(), true);
  assert.equal(runner.getState().micOn, false);
});
