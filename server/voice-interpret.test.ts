import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { InterpretResult, VoiceSession } from "../shared/voice-loop";
import { HELPER_DEFAULT_ON } from "../shared/voice-interpreter";
import { createVoiceInterpret, IDLE_STOP_MS, type InterpretHelper } from "./voice-interpret";

const sessions: VoiceSession[] = [];

function fakeHelper(answer: () => Promise<InterpretResult>, started = true) {
  const calls = { start: 0, stop: 0, interpret: 0 };
  let id: string | null = started ? "h1" : null;
  const helper: InterpretHelper = {
    start: async () => {
      calls.start++;
      id = "h1";
    },
    stop: async () => {
      calls.stop++;
      id = null;
    },
    interpret: () => {
      calls.interpret++;
      return answer();
    },
    agentId: () => id,
  };
  return { helper, calls };
}

const cleaned: InterpretResult = { type: "send", text: "run the tests" };
const ask = (svc: ReturnType<typeof createVoiceInterpret>, text = "Jarvis, run the tests") =>
  svc.interpret(text, { sessionId: "s1", sessions });

test("switch defaults to HELPER_DEFAULT_ON and can be flipped", () => {
  const { helper } = fakeHelper(async () => cleaned);
  const svc = createVoiceInterpret(helper);
  assert.equal(svc.enabled(), HELPER_DEFAULT_ON);
  svc.setEnabled(false);
  assert.equal(svc.enabled(), false);
});

test("switch on: the helper's answer comes back via helper", async () => {
  const { helper } = fakeHelper(async () => cleaned);
  const out = await ask(createVoiceInterpret(helper));
  assert.deepEqual(out, { result: cleaned, via: "helper" });
});

test("switch off: helper never called, name stripped", async () => {
  const { helper, calls } = fakeHelper(async () => cleaned);
  const svc = createVoiceInterpret(helper);
  svc.setEnabled(false);
  const out = await ask(svc);
  assert.equal(calls.interpret, 0);
  assert.equal(out.via, "passThrough");
  assert.equal(out.reason, undefined);
  assert.deepEqual(out.result, { type: "send", text: "run the tests" });
});

test("slow helper (over 3 s) falls back with timeout", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { helper } = fakeHelper(() => new Promise(() => {}));
    const pending = ask(createVoiceInterpret(helper));
    mock.timers.tick(3000);
    const out = await pending;
    assert.equal(out.via, "passThrough");
    assert.equal(out.reason, "timeout");
  } finally {
    mock.timers.reset();
  }
});

test("rejecting helper falls back with error", async () => {
  const { helper } = fakeHelper(async () => {
    throw new Error("boom");
  });
  const out = await ask(createVoiceInterpret(helper));
  assert.equal(out.reason, "error");
  assert.equal(out.via, "passThrough");
});

test("not started: falls back with starting and starts in the background", async () => {
  const { helper, calls } = fakeHelper(async () => cleaned, false);
  const out = await ask(createVoiceInterpret(helper));
  assert.equal(out.reason, "starting");
  assert.equal(out.via, "passThrough");
  assert.equal(calls.interpret, 0);
  assert.equal(calls.start, 1);
});

test("busy: a previous run still going falls back at once", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { helper, calls } = fakeHelper(() => new Promise(() => {}));
    const svc = createVoiceInterpret(helper);
    const first = ask(svc);
    mock.timers.tick(3000);
    await first;
    const second = await ask(svc);
    assert.equal(second.via, "passThrough");
    assert.equal(calls.interpret, 1);
  } finally {
    mock.timers.reset();
  }
});

test("10 minutes with no utterance stops the helper; an utterance resets the clock", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { helper, calls } = fakeHelper(async () => cleaned);
    const svc = createVoiceInterpret(helper);
    await ask(svc);
    mock.timers.tick(IDLE_STOP_MS - 1);
    await ask(svc);
    mock.timers.tick(IDLE_STOP_MS - 1);
    assert.equal(calls.stop, 0);
    mock.timers.tick(1);
    assert.equal(calls.stop, 1);
  } finally {
    mock.timers.reset();
  }
});

test("start, warm and stop drive the helper's lifecycle", async () => {
  const { helper, calls } = fakeHelper(async () => cleaned, false);
  const svc = createVoiceInterpret(helper);
  await svc.start();
  assert.equal(calls.start, 1);
  await svc.warm();
  assert.equal(calls.start, 1, "warm does nothing when already started");
  await svc.stop();
  assert.equal(calls.stop, 1);
  await svc.warm();
  assert.equal(calls.start, 2);
  await svc.stop();
});

test("switch off: start and warm leave the helper stopped", async () => {
  const { helper, calls } = fakeHelper(async () => cleaned, false);
  const svc = createVoiceInterpret(helper);
  svc.setEnabled(false);
  await svc.start();
  await svc.warm();
  assert.equal(calls.start, 0);
  assert.equal(helper.agentId(), null);
});
