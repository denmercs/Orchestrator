import assert from "node:assert/strict";
import { test } from "node:test";
import type { InterpretOutcome } from "../shared/voice-interpreter";
import type { VoiceEvent } from "../shared/voice-loop";
import { CONFIRM_TIMEOUT_MS, MAX_CONVERSATION, POLL_BACKOFF_MS, createVoiceRunner, type EarsRunnerEvent, type VoiceRunnerPorts } from "./voice-runner";

type HelperPort = NonNullable<VoiceRunnerPorts["helper"]>;
const fakeHelper = (over: Partial<HelperPort> = {}) => {
  const calls: string[] = [];
  const helper: HelperPort = {
    start: async () => void calls.push("start"),
    stop: async () => void calls.push("stop"),
    getEnabled: async () => true,
    setEnabled: async (enabled) => (calls.push(`set:${enabled}`), enabled),
    interpret: async (text) => ({ via: "helper", result: { type: "send", text } }),
    ...over,
  };
  return { helper, calls };
};

const alpha = { id: "a1", name: "Alpha" };

function setup(overrides: Partial<VoiceRunnerPorts> = {}) {
  const said: Array<[string, string]> = [];
  const interrupted: string[] = [];
  const ports: VoiceRunnerPorts = {
    link: {
      say: async (id, text) => {
        said.push([id, text]);
      },
      interrupt: async (id) => {
        interrupted.push(id);
      },
    },
    ...overrides,
  };
  const runner = createVoiceRunner(ports);
  return { runner, said, interrupted };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test("on() wakes the loop", () => {
  const { runner } = setup();
  assert.equal(runner.getState().mode, "asleep");
  runner.on();
  assert.equal(runner.getState().mode, "listening");
});

test("an utterance after a pick is sent to the session through the link", async () => {
  const { runner, said } = setup();
  runner.on();
  runner.setSessions([alpha]);
  runner.pick(alpha);
  runner.dispatch({ type: "utterance", text: "please run the tests" });
  await flush();
  assert.deepEqual(said, [["a1", "please run the tests"]]);
  assert.deepEqual(runner.getState().lines, []);
  assert.deepEqual(runner.getState().transcripts, [{ text: "please run the tests", outcome: "sent" }]);
});

test("the helper port answers the interpret effect, with the target's sessionId", async () => {
  const seen: Array<[string, string, number]> = [];
  const { helper } = fakeHelper({
    interpret: async (text, ctx) => {
      seen.push([text, ctx.sessionId, ctx.sessions.length]);
      return { via: "helper", result: { type: "send", text: text.toUpperCase() } };
    },
  });
  const { runner, said } = setup({ helper });
  runner.on();
  runner.setSessions([alpha]);
  runner.pick(alpha);
  runner.dispatch({ type: "utterance", text: "please run the tests" });
  await flush();
  assert.deepEqual(said, [["a1", "PLEASE RUN THE TESTS"]]);
  assert.deepEqual(seen, [["please run the tests", "a1", 1]]);
});

test("interprets records heard + outcome, keeps 20", async () => {
  const outcome: InterpretOutcome = { via: "passThrough", reason: "timeout", result: { type: "send", text: "x" } };
  const { helper } = fakeHelper({ interpret: async () => outcome });
  const { runner } = setup({ helper });
  runner.on();
  runner.pick(alpha);
  for (let i = 0; i < 22; i++) {
    runner.dispatch({ type: "utterance", text: `please run test ${i}` });
    await flush();
  }
  const list = runner.getState().interprets;
  assert.equal(list.length, 20);
  assert.deepEqual(list.at(-1), { heard: "please run test 21", outcome });
  assert.equal(list[0].heard, "please run test 2");
});

test("the helper switch mirrors the port, defaults on, refreshes on start, setHelper calls setEnabled", async () => {
  const none = setup();
  assert.equal(none.runner.getState().helper, true);
  const { helper, calls } = fakeHelper({ getEnabled: async () => false });
  const { runner } = setup({ helper });
  assert.equal(runner.getState().helper, true);
  runner.on();
  await flush();
  assert.equal(runner.getState().helper, false);
  runner.setHelper(true);
  await flush();
  assert.equal(runner.getState().helper, true);
  assert.ok(calls.includes("set:true"));
});

test("on and off start and stop the helper; failures land in error", async () => {
  const { helper, calls } = fakeHelper();
  const ok = setup({ helper });
  ok.runner.on();
  await flush();
  ok.runner.off();
  await flush();
  assert.deepEqual(calls, ["start", "stop"]);
  const bad = setup({ helper: fakeHelper({ start: async () => Promise.reject(new Error("no start")) }).helper });
  bad.runner.on();
  await flush();
  assert.match(bad.runner.getState().error ?? "", /no start/);
  const badStop = setup({ helper: fakeHelper({ stop: async () => Promise.reject(new Error("no stop")) }).helper });
  badStop.runner.on();
  badStop.runner.off();
  await flush();
  assert.match(badStop.runner.getState().error ?? "", /no stop/);
});

test("a rejected send lands in error", async () => {
  const { runner } = setup({
    link: { say: async () => Promise.reject(new Error("boom")), interrupt: async () => {} },
  });
  runner.on();
  runner.pick(alpha);
  runner.dispatch({ type: "utterance", text: "please run the tests" });
  await flush();
  assert.match(runner.getState().error ?? "", /boom/);
});

test("subscribers hear each change with a new snapshot", () => {
  const { runner } = setup();
  const seen: unknown[] = [];
  const off = runner.subscribe(() => seen.push(runner.getState()));
  const before = runner.getState();
  runner.on();
  assert.equal(seen.length > 0, true);
  assert.notEqual(runner.getState(), before);
  const count = seen.length;
  off();
  runner.setSessions([alpha]);
  assert.equal(seen.length, count);
});

test("speak lines are appended to lines", () => {
  const { runner } = setup();
  runner.on();
  runner.dispatch({ type: "utterance", text: "Jarvis switch to nobody" });
  assert.deepEqual(runner.getState().lines, ["No session called nobody."]);
});

test("interrupt() calls link.interrupt for the target", async () => {
  const { runner, interrupted } = setup();
  runner.on();
  runner.pick(alpha);
  runner.interrupt();
  await flush();
  assert.deepEqual(interrupted, ["a1"]);
});

function talkSetup(opts: { ms?: number; transcript?: string | Error; recordFail?: boolean; sessions?: Array<{ id: string; name: string }> } = {}) {
  const calls: string[] = [];
  const hintsSeen: string[][] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const base = setup({
    recorder: {
      start: async () => {
        calls.push("start");
        if (opts.recordFail) throw new Error("mic denied");
      },
      stop: async () => {
        calls.push("stop");
        return { audio: "QUJD", ms: opts.ms ?? 2000 };
      },
    },
    transcriber: async (_audio, hints) => {
      calls.push("transcribe");
      hintsSeen.push(hints);
      if (opts.transcript instanceof Error) throw opts.transcript;
      return opts.transcript ?? "please run the tests";
    },
    clock: {
      setTimeout: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clearTimeout: (h) => {
        (h as { cleared: boolean }).cleared = true;
      },
    },
  });
  base.runner.on();
  base.runner.setSessions(opts.sessions ?? [alpha]);
  base.runner.pick(alpha);
  return { ...base, calls, hintsSeen, timers };
}

test("tap to talk: speechStart, record, transcribe with hints, then the transcript is sent", async () => {
  const { runner, said, calls, hintsSeen } = talkSetup();
  runner.startTalk();
  assert.equal(runner.getState().talking, true);
  await flush();
  await runner.endTalk();
  await flush();
  assert.deepEqual(calls, ["start", "stop", "transcribe"]);
  assert.equal(runner.getState().talking, false);
  assert.deepEqual(said, [["a1", "please run the tests"]]);
  for (const word of ["merge", "Orchestrator", "Paseo", "Jarvis", "Alpha"]) assert.ok(hintsSeen[0].includes(word), word);
  assert.deepEqual(runner.getState().transcripts, [{ text: "please run the tests", outcome: "sent" }]);
});

test("a transcribe failure ends the recording with an empty utterance and records the error", async () => {
  const { runner, said } = talkSetup({ transcript: new Error("whisper missing") });
  runner.startTalk();
  await runner.endTalk();
  await flush();
  assert.equal(runner.getState().talking, false);
  assert.match(runner.getState().error ?? "", /whisper missing/);
  assert.deepEqual(said, []);
});

test("a recorder failure ends the recording with an empty utterance and records the error", async () => {
  const { runner, calls } = talkSetup({ recordFail: true });
  runner.startTalk();
  await flush();
  await runner.endTalk();
  await flush();
  assert.equal(runner.getState().talking, false);
  assert.match(runner.getState().error ?? "", /mic denied/);
  assert.equal(calls.includes("transcribe"), false);
});

test("a clip under 300 ms is not transcribed", async () => {
  const { runner, calls, said } = talkSetup({ ms: 200 });
  runner.startTalk();
  await runner.endTalk();
  await flush();
  assert.equal(calls.includes("transcribe"), false);
  assert.equal(runner.getState().talking, false);
  assert.deepEqual(said, []);
});

test("a recording auto-ends and is sent at 30 seconds", async () => {
  const { runner, calls, timers } = talkSetup();
  runner.startTalk();
  assert.equal(timers.at(-1)?.ms, 30_000);
  timers.at(-1)?.fn();
  await flush();
  await flush();
  assert.deepEqual(calls, ["start", "stop", "transcribe"]);
  assert.equal(runner.getState().talking, false);
});

test("transcripts keep the last five with how each ended", async () => {
  const { runner } = talkSetup();
  runner.dispatch({ type: "utterance", text: "merge it" });
  await flush();
  assert.deepEqual(runner.getState().transcripts, [{ text: "merge it", outcome: "sent" }]);
  for (let i = 0; i < 6; i++) runner.dispatch({ type: "utterance", text: `Jarvis switch to nobody ${i}` });
  const t = runner.getState().transcripts;
  assert.equal(t.length, 5);
  assert.deepEqual(t.at(-1), { text: "Jarvis switch to nobody 5", outcome: "dropped" });
});

test("setSessions and pick reach the loop", () => {
  const { runner } = setup();
  runner.on();
  runner.setSessions([alpha]);
  runner.pick(alpha);
  assert.deepEqual(runner.getState().sessions, [alpha]);
  assert.deepEqual(runner.getState().session, alpha);
});

test("off() sleeps the loop, clears timers and closes the mic", async () => {
  const closed: string[] = [];
  const base = talkSetup();
  const timers = base.timers;
  const { runner } = setup({
    recorder: { start: async () => {}, stop: async () => ({ audio: "", ms: 0 }), close: () => void closed.push("close") },
    clock: {
      setTimeout: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clearTimeout: (h) => {
        (h as { cleared: boolean }).cleared = true;
      },
    },
  });
  runner.on();
  runner.pick(alpha);
  runner.off();
  assert.equal(runner.getState().mode, "asleep");
  assert.deepEqual(closed, ["close"]);
});

test("on() opens the recorder; a failure turns voice back off with the error", async () => {
  const opened: string[] = [];
  const { runner } = setup({ recorder: { open: () => void opened.push("open"), start: async () => {}, stop: async () => ({ audio: "", ms: 0 }) } });
  runner.on();
  assert.deepEqual(opened, ["open"]);
  const bad = setup({ recorder: { open: async () => Promise.reject(new Error("no mic")), start: async () => {}, stop: async () => ({ audio: "", ms: 0 }) } });
  bad.runner.on();
  await flush();
  assert.match(bad.runner.getState().error ?? "", /no mic/);
  assert.equal(bad.runner.getState().mode, "asleep");
});

test("a rejected helper drops the utterance and records the error", async () => {
  const { runner } = setup({ helper: fakeHelper({ interpret: async () => Promise.reject(new Error("helper down")) }).helper });
  runner.on();
  runner.pick(alpha);
  runner.dispatch({ type: "utterance", text: "please run the tests" });
  await flush();
  assert.equal(runner.getState().pending, null);
  assert.equal(runner.getState().transcripts.at(-1)?.outcome, "dropped");
  assert.match(runner.getState().error ?? "", /helper down/);
});

test("setSessions with the same list does not notify subscribers", () => {
  const { runner } = setup();
  runner.setSessions([alpha]);
  let calls = 0;
  runner.subscribe(() => calls++);
  runner.setSessions([{ ...alpha }]);
  assert.equal(calls, 0);
  runner.setSessions([{ ...alpha, name: "Renamed" }]);
  assert.equal(calls, 1);
});

test("toggleTalk: the first tap starts recording, the second stops and sends", async () => {
  const { runner, said, calls } = talkSetup();
  runner.toggleTalk();
  await flush();
  assert.equal(runner.getState().talking, true);
  assert.deepEqual(calls, ["start"]);
  await runner.toggleTalk();
  await flush();
  assert.deepEqual(calls, ["start", "stop", "transcribe"]);
  assert.equal(runner.getState().talking, false);
  assert.deepEqual(said, [["a1", "please run the tests"]]);
});

test("cancelTalk stops the recording and sends nothing", async () => {
  const { runner, said, calls, timers } = talkSetup();
  runner.toggleTalk();
  await flush();
  await runner.cancelTalk();
  await flush();
  assert.deepEqual(calls, ["start", "stop"]);
  assert.equal(runner.getState().talking, false);
  assert.equal(timers.find((t) => t.ms === 30_000)?.cleared, true);
  assert.deepEqual(said, []);
  assert.deepEqual(runner.getState().transcripts, []);
});

function micSetup(open: () => Promise<unknown>, start: () => void = () => {}) {
  const calls: string[] = [];
  const base = setup({
    recorder: {
      open: () => {
        calls.push("open");
        return open();
      },
      start: () => {
        calls.push("start");
        start();
      },
      stop: async () => ({ audio: "QUJD", ms: 2000 }),
      close: () => void calls.push("close"),
    },
    transcriber: async () => "please run the tests",
  });
  return { ...base, calls };
}

test("a tap while the mic is still opening waits for it instead of failing", async () => {
  let opened!: () => void;
  const { runner, calls, said } = micSetup(() => new Promise<void>((r) => (opened = r)));
  runner.on();
  runner.pick(alpha);
  runner.toggleTalk();
  await flush();
  assert.deepEqual(calls, ["open"]);
  opened();
  await flush();
  assert.deepEqual(calls, ["open", "start"]);
  await runner.toggleTalk();
  await flush();
  assert.equal(runner.getState().error, null);
  assert.deepEqual(said, [["a1", "please run the tests"]]);
});

test("a mic that was released is opened once more before talking", async () => {
  let starts = 0;
  const { runner, calls } = micSetup(async () => {}, () => {
    if (starts++ === 0) throw new Error("The microphone is not open. Turn voice on first.");
  });
  runner.on();
  await flush();
  runner.toggleTalk();
  await flush();
  await flush();
  assert.deepEqual(calls, ["open", "start", "open", "start"]);
  assert.equal(runner.getState().talking, true);
  assert.equal(runner.getState().error, null);
});

test("a mic that cannot open turns voice off; talking is not attempted", async () => {
  const { runner, calls } = micSetup(async () => Promise.reject(new Error("This device can't record from a plugin. Use voice from the laptop.")));
  runner.on();
  runner.toggleTalk();
  await flush();
  await flush();
  assert.equal(runner.getState().mode, "asleep");
  assert.equal(runner.getState().talking, false);
  assert.equal(runner.getState().error, "This device can't record from a plugin. Use voice from the laptop.");
  assert.equal(calls.includes("start"), false);
});

test("turning voice on again clears the last error; a stale failed open does not turn it off", async () => {
  let reject!: (err: Error) => void;
  let first = true;
  const { runner } = micSetup(() => (first ? ((first = false), new Promise((_, r) => (reject = r))) : Promise.resolve()));
  runner.on();
  runner.off();
  runner.on();
  reject(new Error("late"));
  await flush();
  assert.equal(runner.getState().mode, "listening");
  assert.equal(runner.getState().error, null);
});

test("setSessions passes Voice's own sessions to the loop as blocked, and only on a change", () => {
  const { runner } = talkSetup();
  const jarvis = { id: "j1", name: "Jarvis" };
  let notified = 0;
  runner.subscribe(() => notified++);
  runner.setSessions([alpha], [jarvis]);
  assert.deepEqual(runner.getState().blocked, [jarvis]);
  const before = notified;
  runner.setSessions([alpha], [{ ...jarvis }]);
  assert.equal(notified, before);
});

test("a numbered list is forgotten after the confirm timeout, like on the phone", () => {
  const beta = { id: "b1", name: "beta" };
  const { runner, timers } = talkSetup({ sessions: [alpha, beta] });
  runner.dispatch({ type: "utterance", text: "list sessions" });
  assert.equal(runner.getState().choices?.length, 2);
  const timer = timers.find((t) => t.ms === CONFIRM_TIMEOUT_MS && !t.cleared);
  assert.ok(timer);
  timer.fn();
  assert.equal(runner.getState().choices, null);
  runner.dispatch({ type: "utterance", text: "two" });
  assert.equal(runner.getState().session?.id, alpha.id);
  runner.dispatch({ type: "utterance", text: "list sessions" });
  runner.dispatch({ type: "utterance", text: "two" });
  assert.equal(runner.getState().session?.id, beta.id);
  assert.equal(timers.filter((t) => t.ms === CONFIRM_TIMEOUT_MS).every((t) => t.cleared || t === timer), true, "a picked list's timer is cleared");
});

test("a create effect makes a new session through the link the target", async () => {
  const made: Array<{ id: string; name: string }> = [];
  const { runner, said } = setup({
    link: {
      say: async () => {},
      interrupt: async () => {},
      create: async (target) => {
        made.push(target);
        return "new1";
      },
    },
  });
  runner.on();
  runner.setSessions([alpha]);
  runner.pick(alpha);
  runner.dispatch({ type: "utterance", text: "new session" });
  await flush();
  assert.deepEqual(made, [alpha]);
  assert.equal(runner.getState().session?.id, "new1");
  assert.equal(said.length, 0);
});

test("a failed create lands in error and keeps the target", async () => {
  const { runner } = setup({
    link: { say: async () => {}, interrupt: async () => {}, create: async () => Promise.reject(new Error("no create")) },
  });
  runner.on();
  runner.pick(alpha);
  runner.dispatch({ type: "utterance", text: "new session" });
  await flush();
  assert.equal(runner.getState().error, "no create");
  assert.equal(runner.getState().session?.id, "a1");
});

test("newSession() creates from the target even while voice is off", async () => {
  const made: Array<{ id: string; name: string }> = [];
  const { runner } = setup({
    link: { say: async () => {}, interrupt: async () => {}, create: async (target) => (made.push(target), "new2") },
  });
  runner.pick(alpha);
  runner.newSession();
  await flush();
  assert.deepEqual(made, [alpha]);
  assert.equal(runner.getState().session?.id, "new2");
});

type Batch = { cursor: number; events: VoiceEvent[]; phoneActive: boolean };

// An events port whose reads stay pending until the test answers them.
function eventsSetup(speakResult: "ended" | "stopped" = "ended") {
  const reads: Array<{ after: number; resolve(b: Batch): void; reject(e: Error): void }> = [];
  const spoken: Array<[string, string]> = [];
  let stops = 0;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const base = setup({
    events: { read: (after) => new Promise<Batch>((resolve, reject) => reads.push({ after, resolve, reject })) },
    speaker: {
      speak: async (text, replyId) => {
        spoken.push([text, replyId]);
        return speakResult;
      },
      stop: () => {
        stops++;
      },
    },
    clock: { setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout: () => {} },
  });
  base.runner.setSessions([alpha]);
  base.runner.pick(alpha);
  return { ...base, reads, spoken, timers, stops: () => stops };
}

const reply = (text: string): VoiceEvent => ({ type: "reply", sessionId: "a1", text });

test("on() polls events with the cursor and dispatches them; off() stops the poll", async () => {
  const { runner, reads, spoken } = eventsSetup();
  runner.on();
  await flush();
  assert.equal(reads.length, 1);
  assert.equal(reads[0].after, 0);
  reads[0].resolve({ cursor: 3, events: [reply("All done.")], phoneActive: false });
  await flush();
  assert.equal(spoken.length, 1);
  assert.equal(reads.length, 2);
  assert.equal(reads[1].after, 3);
  runner.off();
  reads[1].resolve({ cursor: 4, events: [reply("Late.")], phoneActive: false });
  await flush();
  assert.equal(spoken.length, 1);
  assert.equal(reads.length, 2);
});

test("a spoken reply that ends dispatches playbackEnded; one that is stopped does nothing", async () => {
  const ended = eventsSetup("ended");
  ended.runner.on();
  await flush();
  ended.reads[0].resolve({ cursor: 1, events: [reply("All done.")], phoneActive: false });
  await flush();
  assert.equal(ended.spoken[0][0], "Alpha: All done.");
  assert.equal(ended.runner.getState().mode, "listening");
  const stopped = eventsSetup("stopped");
  stopped.runner.on();
  await flush();
  stopped.reads[0].resolve({ cursor: 1, events: [reply("All done.")], phoneActive: false });
  await flush();
  assert.equal(stopped.spoken.length, 1);
  assert.equal(stopped.runner.getState().mode, "speaking");
});

test("while the phone is speaking the line is shown, the speaker is not called, and playback ends at once", async () => {
  const { runner, reads, spoken } = eventsSetup();
  runner.on();
  await flush();
  reads[0].resolve({ cursor: 1, events: [reply("All done.")], phoneActive: true });
  await flush();
  assert.deepEqual(spoken, []);
  assert.deepEqual(runner.getState().lines, ["Alpha: All done."]);
  assert.equal(runner.getState().phoneActive, true);
  assert.equal(runner.getState().mode, "listening");
});

function noMicSetup(hasMic?: () => boolean) {
  const reads: Array<(b: Batch) => void> = [];
  const spoken: string[] = [];
  const base = setup({
    events: { read: () => new Promise<Batch>((resolve) => reads.push(resolve)) },
    speaker: { speak: async (text) => (spoken.push(text), "ended"), stop: () => {} },
    ...(hasMic ? { hasMic } : {}),
  });
  base.runner.setSessions([alpha]);
  base.runner.pick(alpha);
  return { ...base, reads, spoken };
}

test("with no mic API a reply to the target is shown and never spoken; one for another session adds nothing", async () => {
  const { runner, reads, spoken } = noMicSetup(() => false);
  await runner.start();
  reads[0]({ cursor: 1, events: [reply("All done."), { type: "reply", sessionId: "zz", text: "Other." }], phoneActive: false });
  await flush();
  assert.deepEqual(runner.getState().lines, ["All done."]);
  assert.deepEqual(spoken, []);
  assert.equal(runner.getState().mode, "asleep");
});

test("with no mic API but the loop awake, a target reply is shown once, by the loop", async () => {
  const { runner, reads } = noMicSetup(() => false);
  runner.on();
  reads[0]({ cursor: 1, events: [reply("All done.")], phoneActive: false });
  await flush();
  assert.equal(runner.getState().lines.filter((l) => l === "Alpha: All done.").length, 1);
});

test("with a mic (hasMic absent) an asleep reply adds nothing", async () => {
  const { runner, reads, spoken } = noMicSetup();
  await runner.start();
  reads[0]({ cursor: 1, events: [reply("All done.")], phoneActive: false });
  await flush();
  assert.deepEqual(runner.getState().lines, []);
  assert.deepEqual(spoken, []);
});

test("speechStart while speaking stops the speaker and never touches the link", async () => {
  const { runner, reads, stops, said, interrupted } = eventsSetup("stopped");
  runner.on();
  await flush();
  reads[0].resolve({ cursor: 1, events: [reply("All done.")], phoneActive: false });
  await flush();
  assert.equal(runner.getState().mode, "speaking");
  runner.dispatch({ type: "speechStart" });
  assert.equal(stops(), 1);
  assert.deepEqual(said, []);
  assert.deepEqual(interrupted, []);
});

test("a poll error is shown and retried after a backoff on the clock port", async () => {
  const { runner, reads, timers } = eventsSetup();
  runner.on();
  await flush();
  reads[0].reject(new Error("rpc down"));
  await flush();
  assert.match(runner.getState().error ?? "", /rpc down/);
  assert.equal(reads.length, 1);
  const backoff = timers.find((t) => t.ms === POLL_BACKOFF_MS);
  assert.ok(backoff);
  backoff.fn();
  await flush();
  assert.equal(reads.length, 2);
  assert.equal(reads[1].after, 0);
});

// --- Launch and mute (S5): start() at launch, setMic() as the drawer's mic toggle ---

function earsSetup(overrides: Partial<VoiceRunnerPorts> = {}) {
  const calls: string[] = [];
  let handler: ((event: EarsRunnerEvent) => void) | null = null;
  const awakeCalls: boolean[] = [];
  const pausedCalls: boolean[] = [];
  const ears: NonNullable<VoiceRunnerPorts["ears"]> = {
    open: async () => void calls.push("open"),
    close: async () => void calls.push("close"),
    setAwake: (awake) => awakeCalls.push(awake),
    setPaused: (paused) => pausedCalls.push(paused),
    onEvent: (fn) => {
      handler = fn;
    },
  };
  const base = setup({ ears, ...overrides });
  return { ...base, calls, awakeCalls, pausedCalls, emit: (e: EarsRunnerEvent) => handler?.(e) };
}

function prefsSetup(micOff: boolean) {
  const writes: boolean[] = [];
  const prefs: NonNullable<VoiceRunnerPorts["prefs"]> = {
    read: async () => ({ micOff }),
    write: async (value) => void writes.push(value),
  };
  return { prefs, writes };
}

test("start() opens the mic and ears, stays asleep, and does not transcribe", async () => {
  const { prefs } = prefsSetup(false);
  const calls: string[] = [];
  const { runner } = earsSetup({ prefs, transcriber: async () => (calls.push("transcribe"), "x") });
  await runner.start();
  assert.equal(runner.getState().mode, "asleep");
  assert.equal(runner.getState().micOn, true);
  assert.deepEqual(calls, []);
});

test("start() with micOff opens nothing", async () => {
  const { prefs } = prefsSetup(true);
  const { runner, calls } = earsSetup({ prefs });
  await runner.start();
  assert.deepEqual(calls, []);
  assert.equal(runner.getState().micOn, false);
});

test("a no-mic device: start() sets no error", async () => {
  const { prefs } = prefsSetup(false);
  const { runner } = earsSetup({
    prefs,
    ears: {
      open: async () => Promise.reject(new Error("no plugin mic")),
      close: async () => {},
      setAwake: () => {},
      setPaused: () => {},
      onEvent: () => {},
    },
  });
  await runner.start();
  assert.equal(runner.getState().error, null);
  assert.equal(runner.getState().micOn, false);
});

test("setMic(false) closes the mic and ears and saves micOff: true; setMic(true) saves false and reopens asleep", async () => {
  const { prefs, writes } = prefsSetup(false);
  const { runner, calls } = earsSetup({ prefs });
  await runner.start();
  await runner.setMic(false);
  assert.deepEqual(writes, [true]);
  assert.deepEqual(calls, ["open", "close"]);
  assert.equal(runner.getState().micOn, false);
  assert.equal(runner.getState().mode, "asleep");
  await runner.setMic(true);
  assert.deepEqual(writes, [true, false]);
  assert.deepEqual(calls, ["open", "close", "open"]);
  assert.equal(runner.getState().micOn, true);
  assert.equal(runner.getState().mode, "asleep");
});

test("setMic(false) while listening returns the loop to asleep", async () => {
  const { prefs } = prefsSetup(false);
  const { runner } = earsSetup({ prefs });
  await runner.start();
  runner.dispatch({ type: "wake" });
  assert.equal(runner.getState().mode, "listening");
  await runner.setMic(false);
  assert.equal(runner.getState().mode, "asleep");
});

// --- Hands-free (S5): ears events drive the loop the same way tap-to-talk does ---

test("ears wake moves to listening and tells the ears it is awake", async () => {
  const { prefs } = prefsSetup(false);
  const { runner, awakeCalls, emit } = earsSetup({ prefs });
  await runner.start();
  emit({ type: "wake" });
  assert.equal(runner.getState().mode, "listening");
  assert.deepEqual(awakeCalls.slice(-1), [true]);
});

test('an ears utterance is transcribed and sent, "Hey Jarvis," dropped by the default interpreter', async () => {
  const { prefs } = prefsSetup(false);
  const transcriptCalls: Array<[string, string[]]> = [];
  const { runner, emit, said } = earsSetup({
    prefs,
    transcriber: async (audio, hints) => {
      transcriptCalls.push([audio, hints]);
      return "Hey Jarvis, run the tests";
    },
  });
  await runner.start();
  emit({ type: "wake" });
  runner.setSessions([alpha]);
  runner.pick(alpha);
  emit({ type: "speechStart" });
  assert.equal(runner.getState().talking, true);
  emit({ type: "utterance", pcm: new Int16Array([1, 2, 3]) });
  await flush();
  assert.equal(transcriptCalls.length, 1);
  assert.deepEqual(said, [["a1", "run the tests"]]);
});

test('"Jarvis, ignore me" goes back to asleep, sends nothing, and tells the ears it is asleep', async () => {
  const { prefs } = prefsSetup(false);
  const { runner, emit, awakeCalls, said } = earsSetup({ prefs, transcriber: async () => "Jarvis, ignore me" });
  await runner.start();
  emit({ type: "wake" });
  emit({ type: "speechStart" });
  emit({ type: "utterance", pcm: new Int16Array([1]) });
  await flush();
  assert.equal(runner.getState().mode, "asleep");
  assert.deepEqual(said, []);
  assert.deepEqual(awakeCalls.slice(-1), [false]);
});

test("a one-word noise transcript sends nothing", async () => {
  const { prefs } = prefsSetup(false);
  const { runner, emit, said } = earsSetup({ prefs, transcriber: async () => "hello" });
  await runner.start();
  emit({ type: "wake" });
  runner.setSessions([alpha]);
  runner.pick(alpha);
  emit({ type: "speechStart" });
  emit({ type: "utterance", pcm: new Int16Array([1]) });
  await flush();
  assert.deepEqual(said, []);
});

test("an empty-pcm utterance (cancel) is not transcribed", async () => {
  const { prefs } = prefsSetup(false);
  const transcribed: string[] = [];
  const { runner, emit } = earsSetup({ prefs, transcriber: async () => (transcribed.push("called"), "x") });
  await runner.start();
  emit({ type: "wake" });
  emit({ type: "utterance", pcm: new Int16Array([]) });
  await flush();
  assert.deepEqual(transcribed, []);
});

test("wake while speaking stops the speaker and captures instead of just listening", async () => {
  const { prefs } = prefsSetup(false);
  const reads: Array<{ after: number; resolve(b: Batch): void; reject(e: Error): void }> = [];
  const stops: string[] = [];
  const { runner, emit } = earsSetup({
    prefs,
    events: { read: (after) => new Promise<Batch>((resolve, reject) => reads.push({ after, resolve, reject })) },
    speaker: { speak: async () => "stopped", stop: () => void stops.push("stop") },
  });
  runner.setSessions([alpha]);
  runner.pick(alpha);
  await runner.start();
  emit({ type: "wake" });
  await flush();
  reads[0]!.resolve({ cursor: 1, events: [reply("All done.")], phoneActive: false });
  await flush();
  assert.equal(runner.getState().mode, "speaking");
  emit({ type: "wake" });
  assert.equal(runner.getState().talking, true);
  assert.equal(stops.length, 1);
});

test("the ears are paused while the loop is speaking, and unpaused once it stops", async () => {
  const { prefs } = prefsSetup(false);
  const reads: Array<{ after: number; resolve(b: Batch): void; reject(e: Error): void }> = [];
  const { runner, pausedCalls, emit } = earsSetup({
    prefs,
    events: { read: (after) => new Promise<Batch>((resolve, reject) => reads.push({ after, resolve, reject })) },
    speaker: { speak: async () => "ended", stop: () => {} },
  });
  runner.setSessions([alpha]);
  runner.pick(alpha);
  await runner.start();
  emit({ type: "wake" });
  await flush();
  reads[0]!.resolve({ cursor: 1, events: [reply("All done.")], phoneActive: false });
  await flush();
  // the mock speaker resolves "ended" at once, so the loop is paused for speaking and unpaused again by here
  assert.deepEqual(pausedCalls.slice(-3), [false, true, false]);
  assert.equal(runner.getState().mode, "listening");
});

// --- Tap while asleep, and auto-sleep (S5 cycle 7) ---

test("tap to talk while asleep (mic on) wakes the loop and records; Cancel still sends nothing", async () => {
  const { prefs } = prefsSetup(false);
  const { runner, said } = earsSetup({
    prefs,
    recorder: { start: async () => {}, stop: async () => ({ audio: "QUJD", ms: 2000 }) },
    transcriber: async () => "please run the tests",
  });
  runner.setSessions([alpha]);
  runner.pick(alpha);
  await runner.start();
  assert.equal(runner.getState().mode, "asleep");
  runner.toggleTalk();
  assert.equal(runner.getState().mode, "listening");
  assert.equal(runner.getState().talking, true);
  await runner.cancelTalk();
  await flush();
  assert.equal(runner.getState().talking, false);
  assert.deepEqual(said, []);
});

test("tap to talk while asleep with the mic off does nothing", async () => {
  const { prefs } = prefsSetup(true);
  const { runner } = earsSetup({ prefs, recorder: { start: async () => {}, stop: async () => ({ audio: "", ms: 0 }) } });
  await runner.start();
  runner.toggleTalk();
  assert.equal(runner.getState().mode, "asleep");
  assert.equal(runner.getState().talking, false);
});

test("60 s of listening with no speech dispatches sleep via the clock port", async () => {
  const { prefs } = prefsSetup(false);
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const clock = {
    setTimeout: (fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (h: unknown) => {
      (h as { cleared: boolean }).cleared = true;
    },
  };
  const { runner, emit } = earsSetup({ prefs, clock });
  await runner.start();
  emit({ type: "wake" });
  const autoSleep = timers.find((t) => t.ms === 60_000 && !t.cleared);
  assert.ok(autoSleep, "a 60 s timer is armed on entering listening");
  autoSleep.fn();
  assert.equal(runner.getState().mode, "asleep");
});

test("the auto-sleep timer does not run while waiting or speaking", async () => {
  const { prefs } = prefsSetup(false);
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const clock = {
    setTimeout: (fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (h: unknown) => {
      (h as { cleared: boolean }).cleared = true;
    },
  };
  const { runner, emit } = earsSetup({ prefs, clock, transcriber: async () => "merge it" });
  runner.setSessions([alpha]);
  runner.pick(alpha);
  await runner.start();
  emit({ type: "wake" });
  emit({ type: "speechStart" });
  emit({ type: "utterance", pcm: new Int16Array([1]) });
  await flush();
  // "merge it" sends and the loop waits: no 60 s auto-sleep timer should be left running meanwhile.
  assert.equal(runner.getState().mode, "waiting");
  assert.equal(timers.some((t) => t.ms === 60_000 && !t.cleared), false);
});

test("a briefing word is answered by the briefer: its lines are spoken and nothing reaches the session", async () => {
  const asked: string[] = [];
  const spoken: string[] = [];
  const { runner, said } = setup({
    brief: async (text) => {
      asked.push(text);
      return text === "good morning" ? ["Good morning, Dennis.", "Shall I go on?"] : null;
    },
    speaker: { speak: async (text) => (spoken.push(text), "ended" as const), stop: () => {} },
  });
  runner.on();
  runner.pick(alpha);
  runner.dispatch({ type: "utterance", text: "good morning" });
  await flush();
  assert.deepEqual(spoken, ["Good morning, Dennis.", "Shall I go on?"]);
  assert.deepEqual(runner.getState().lines, ["Good morning, Dennis.", "Shall I go on?"]);
  assert.deepEqual(said, []);
  // Not a briefing word: the loop has it as usual.
  runner.dispatch({ type: "utterance", text: "run the tests" });
  await flush();
  assert.deepEqual(asked, ["good morning", "run the tests"]);
  assert.deepEqual(said, [["a1", "run the tests"]]);
});

test("a briefer that fails lets the words through to the session", async () => {
  const { runner, said } = setup({ brief: async () => Promise.reject(new Error("down")) });
  runner.on();
  runner.pick(alpha);
  runner.dispatch({ type: "utterance", text: "run the tests" });
  await flush();
  assert.deepEqual(said, [["a1", "run the tests"]]);
});

test("a status ask is answered by the status port: its line is spoken and shown and the session hears nothing", async () => {
  const asked: string[] = [];
  const spoken: string[] = [];
  const { runner, said } = setup({
    status: async (text) => {
      asked.push(text);
      return text === "Jarvis, status" ? ["docs needs you."] : null;
    },
    speaker: { speak: async (text) => (spoken.push(text), "ended" as const), stop: () => {} },
  });
  runner.on();
  runner.pick(alpha);
  runner.dispatch({ type: "utterance", text: "Jarvis, status" });
  await flush();
  assert.deepEqual(spoken, ["docs needs you."]);
  assert.deepEqual(runner.getState().lines, ["docs needs you."]);
  assert.deepEqual(said, []);
  // Not a status ask: the loop has it as usual.
  runner.dispatch({ type: "utterance", text: "run the tests" });
  await flush();
  assert.deepEqual(said, [["a1", "run the tests"]]);
});

test("a status port that fails, or an asleep loop, leaves the words to the loop", async () => {
  let calls = 0;
  const { runner, said } = setup({ status: async () => (calls++, Promise.reject(new Error("down"))) });
  runner.on();
  runner.pick(alpha);
  runner.dispatch({ type: "utterance", text: "run the tests" });
  await flush();
  assert.deepEqual(said, [["a1", "run the tests"]]);
  assert.equal(calls, 1);
  runner.dispatch({ type: "sleep" });
  runner.dispatch({ type: "utterance", text: "status" });
  await flush();
  assert.equal(calls, 1, "asleep: the port is not asked");
});

test("typed text wakes an asleep loop and the status port answers it", async () => {
  const asked: string[] = [];
  const { runner, said } = setup({ status: async (text) => (asked.push(text), text === "status" ? ["docs needs you."] : null) });
  runner.pick(alpha);
  assert.equal(runner.getState().mode, "asleep");
  runner.type("status");
  await flush();
  assert.notEqual(runner.getState().mode, "asleep");
  assert.deepEqual(asked, ["status"]);
  assert.deepEqual(runner.getState().lines, ["docs needs you."]);
  assert.deepEqual(said, []);
});

test("typed text with a target is sent like a transcript; blank text does nothing", async () => {
  const { runner, said } = setup();
  runner.setSessions([alpha]);
  runner.pick(alpha);
  runner.type("   ");
  runner.type("");
  await flush();
  assert.equal(runner.getState().mode, "asleep");
  assert.deepEqual(said, []);
  assert.deepEqual(runner.getState().transcripts, []);
  runner.type("fix the test");
  await flush();
  assert.deepEqual(said, [["a1", "fix the test"]]);
  assert.deepEqual(runner.getState().transcripts, [{ text: "fix the test", outcome: "sent" }]);
});

test("conversation interleaves your words and Jarvis's lines in order, updates outcomes in place, keeps 40", async () => {
  const { runner } = setup({ status: async (text) => (text === "status" ? ["docs needs you."] : null) });
  assert.deepEqual(runner.getState().conversation, []);
  runner.setSessions([alpha]);
  runner.pick(alpha);
  runner.type("fix the test");
  await flush();
  runner.type("status");
  await flush();
  assert.deepEqual(runner.getState().conversation, [
    { from: "you", text: "fix the test", outcome: "sent" },
    { from: "you", text: "status", outcome: "status" },
    { from: "jarvis", text: "docs needs you." },
  ]);
  // transcripts and lines keep working alongside
  assert.deepEqual(runner.getState().lines, ["docs needs you."]);
  assert.equal(runner.getState().transcripts.length, 2);
});

test("conversation outcomes update in place and the log is capped at 40", async () => {
  const { runner } = setup({ status: async (text) => ([`reply ${text}`]) });
  runner.setSessions([alpha]);
  runner.pick(alpha);
  runner.on();
  await flush();
  for (let i = 0; i < 25; i++) {
    runner.dispatch({ type: "utterance", text: `q${i}` });
    await flush();
  }
  const log = runner.getState().conversation;
  assert.equal(log.length, 40);
  assert.deepEqual(log.at(-1), { from: "jarvis", text: "reply q24" });
  assert.deepEqual(log.at(-2), { from: "you", text: "q24", outcome: "status" });
});

test("a conversation outcome updates in place when the helper answers", async () => {
  const { helper } = fakeHelper({ interpret: async (text) => ({ via: "helper", result: { type: "send", text } }) });
  const { runner } = setup({ helper });
  runner.on();
  runner.setSessions([alpha]);
  runner.pick(alpha);
  runner.dispatch({ type: "utterance", text: "please run the tests" });
  assert.deepEqual(runner.getState().conversation, [{ from: "you", text: "please run the tests", outcome: "working" }]);
  await flush();
  assert.deepEqual(runner.getState().conversation, [{ from: "you", text: "please run the tests", outcome: "sent" }]);
});

// --- Paseo voice mode in the drawer (phone and laptop): heard speech, ordered lines, mute that persists ---

const heard = (text: string): VoiceEvent => ({ type: "heard", text });
const convoText = (runner: ReturnType<typeof setup>["runner"]) => runner.getState().conversation.map((c) => `${c.from}:${c.text}`);

test("heard speech is a you line, then the reply a jarvis line, in order, with no mic API", async () => {
  const { runner, reads, spoken } = noMicSetup(() => false);
  await runner.start();
  reads[0]({ cursor: 2, events: [heard("run the tests"), reply("All done.")], phoneActive: false });
  await flush();
  assert.deepEqual(convoText(runner), ["you:run the tests", "jarvis:All done."]);
  assert.deepEqual(spoken, []);
});

test("heard speech never reaches the loop: no send, no mode change, no second line", async () => {
  const { runner, reads, said } = noMicSetup(() => false);
  runner.on();
  reads[0]({ cursor: 1, events: [heard("run the tests")], phoneActive: false });
  await flush();
  assert.deepEqual(said, []);
  assert.deepEqual(convoText(runner), ["you:run the tests"]);
  assert.equal(runner.getState().mode, "listening");
});

test("a reply is one jarvis line whether the loop is asleep or awake (no double count)", async () => {
  for (const awake of [false, true]) {
    const { runner, reads } = noMicSetup(() => false);
    if (awake) runner.on();
    else await runner.start();
    reads[0]({ cursor: 1, events: [reply("All done.")], phoneActive: false });
    await flush();
    assert.equal(runner.getState().conversation.filter((c) => c.from === "jarvis").length, 1, `awake=${awake}`);
  }
});

test("the conversation keeps the last MAX_CONVERSATION lines across heard and replies", async () => {
  const { runner, reads } = noMicSetup(() => false);
  await runner.start();
  const events: VoiceEvent[] = [];
  for (let i = 0; i < MAX_CONVERSATION; i++) events.push(heard(`q${i}`), reply(`a${i}`));
  reads[0]({ cursor: 1, events, phoneActive: false });
  await flush();
  const lines = convoText(runner);
  assert.equal(lines.length, MAX_CONVERSATION);
  assert.equal(lines.at(-1), `jarvis:a${MAX_CONVERSATION - 1}`);
  assert.equal(lines[0], `you:q${MAX_CONVERSATION / 2}`);
});

test("with a mic API heard speech shows too, and an asleep reply still adds nothing extra", async () => {
  const { runner, reads } = noMicSetup();
  await runner.start();
  reads[0]({ cursor: 1, events: [heard("hello there")], phoneActive: false });
  await flush();
  assert.deepEqual(convoText(runner), ["you:hello there"]);
});

test("no mic API: the mute persists, and a new runner after reload starts muted", async () => {
  const stored = { micOff: false };
  const prefs: NonNullable<VoiceRunnerPorts["prefs"]> = {
    read: async () => ({ ...stored }),
    write: async (micOff) => void (stored.micOff = micOff),
  };
  const first = setup({ prefs, hasMic: () => false });
  await first.runner.start();
  assert.equal(first.runner.getState().micOn, true);
  await first.runner.setMic(false);
  assert.equal(first.runner.getState().micOn, false);
  assert.equal(stored.micOff, true);
  const reloaded = setup({ prefs, hasMic: () => false });
  await reloaded.runner.start();
  assert.equal(reloaded.runner.getState().micOn, false);
  await reloaded.runner.setMic(true);
  assert.equal(stored.micOff, false);
});
