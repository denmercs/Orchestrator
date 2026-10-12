import assert from "node:assert/strict";
import { test } from "node:test";
import { createVoiceRunner, type VoiceRunnerPorts } from "./voice-runner";

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
  assert.deepEqual(runner.getState().lines, ["Sent to Alpha"]);
  assert.deepEqual(runner.getState().transcripts, [{ text: "please run the tests", outcome: "sent to Alpha" }]);
});

test("a custom interpreter answers the interpret effect", async () => {
  const { runner, said } = setup({ interpreter: async (text) => ({ type: "send", text: text.toUpperCase() }) });
  runner.on();
  runner.pick(alpha);
  runner.dispatch({ type: "utterance", text: "please run the tests" });
  await flush();
  assert.deepEqual(said, [["a1", "PLEASE RUN THE TESTS"]]);
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

test("hold to talk: speechStart, record, transcribe with hints, then the transcript is sent", async () => {
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
  assert.deepEqual(runner.getState().transcripts, [{ text: "please run the tests", outcome: "sent to Alpha" }]);
});

test("a transcribe failure ends the hold with an empty utterance and records the error", async () => {
  const { runner, said } = talkSetup({ transcript: new Error("whisper missing") });
  runner.startTalk();
  await runner.endTalk();
  await flush();
  assert.equal(runner.getState().talking, false);
  assert.match(runner.getState().error ?? "", /whisper missing/);
  assert.deepEqual(said, []);
});

test("a recorder failure ends the hold with an empty utterance and records the error", async () => {
  const { runner, calls } = talkSetup({ recordFail: true });
  runner.startTalk();
  await flush();
  await runner.endTalk();
  await flush();
  assert.equal(runner.getState().talking, false);
  assert.match(runner.getState().error ?? "", /mic denied/);
  assert.equal(calls.includes("transcribe"), false);
});

test("a hold under 300 ms is not transcribed", async () => {
  const { runner, calls, said } = talkSetup({ ms: 200 });
  runner.startTalk();
  await runner.endTalk();
  await flush();
  assert.equal(calls.includes("transcribe"), false);
  assert.equal(runner.getState().talking, false);
  assert.deepEqual(said, []);
});

test("a hold auto-ends at 30 seconds", async () => {
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
  assert.deepEqual(runner.getState().transcripts, [{ text: "merge it", outcome: "asked to confirm" }]);
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

test("a risky utterance asks to confirm and sends nothing; yes does nothing; merge sends", async () => {
  const { runner, said } = talkSetup();
  runner.dispatch({ type: "utterance", text: "merge it" });
  await flush();
  assert.deepEqual(said, []);
  assert.equal(runner.getState().mode, "confirming");
  assert.match(runner.getState().lines.at(-1) ?? "", /Say one to send/);
  runner.dispatch({ type: "utterance", text: "yes" });
  await flush();
  assert.deepEqual(said, []);
  assert.equal(runner.getState().mode, "confirming");
  runner.dispatch({ type: "utterance", text: "merge" });
  await flush();
  assert.deepEqual(said, [["a1", "merge it"]]);
});

test("saying one sends the confirmed text", async () => {
  const { runner, said } = talkSetup();
  runner.dispatch({ type: "utterance", text: "merge it" });
  await flush();
  runner.dispatch({ type: "utterance", text: "one" });
  await flush();
  assert.deepEqual(said, [["a1", "merge it"]]);
});

test("confirm(word) from a button sends", async () => {
  const { runner, said } = talkSetup();
  runner.dispatch({ type: "utterance", text: "merge it" });
  await flush();
  runner.confirm("merge");
  await flush();
  assert.deepEqual(said, [["a1", "merge it"]]);
  assert.equal(runner.getState().mode, "waiting");
});

test("the confirm times out after 10 seconds and cancels", async () => {
  const { runner, said, timers } = talkSetup();
  runner.dispatch({ type: "utterance", text: "merge it" });
  await flush();
  const timer = timers.at(-1);
  assert.equal(timer?.ms, 10_000);
  timer?.fn();
  await flush();
  assert.equal(runner.getState().mode, "listening");
  assert.equal(runner.getState().confirm, null);
  assert.deepEqual(said, []);
});

test("sending clears the confirm timer", async () => {
  const { runner, timers } = talkSetup();
  runner.dispatch({ type: "utterance", text: "merge it" });
  await flush();
  const timer = timers.at(-1);
  assert.equal(timer?.cleared, false);
  runner.confirm("merge");
  await flush();
  assert.equal(timer?.cleared, true);
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
  runner.dispatch({ type: "utterance", text: "merge it" });
  await flush();
  const timer = timers.at(-1);
  runner.off();
  assert.equal(runner.getState().mode, "asleep");
  assert.equal(timer?.cleared, true);
  assert.deepEqual(closed, ["close"]);
});

test("on() opens the recorder; a failure lands in error", async () => {
  const opened: string[] = [];
  const { runner } = setup({ recorder: { open: () => void opened.push("open"), start: async () => {}, stop: async () => ({ audio: "", ms: 0 }) } });
  runner.on();
  assert.deepEqual(opened, ["open"]);
  const bad = setup({ recorder: { open: async () => Promise.reject(new Error("no mic")), start: async () => {}, stop: async () => ({ audio: "", ms: 0 }) } });
  bad.runner.on();
  await flush();
  assert.match(bad.runner.getState().error ?? "", /no mic/);
  assert.equal(bad.runner.getState().mode, "listening");
});

test("a rejected interpreter drops the utterance and records the error", async () => {
  const { runner } = setup({ interpreter: async () => Promise.reject(new Error("helper down")) });
  runner.on();
  runner.pick(alpha);
  runner.dispatch({ type: "utterance", text: "please run the tests" });
  await flush();
  assert.equal(runner.getState().pending, null);
  assert.equal(runner.getState().transcripts.at(-1)?.outcome, "dropped");
  assert.match(runner.getState().error ?? "", /helper down/);
});

test("a confirm from the button or the timeout updates the transcript that asked", async () => {
  const sent = talkSetup();
  sent.runner.dispatch({ type: "utterance", text: "merge it" });
  await flush();
  assert.equal(sent.runner.getState().transcripts.at(-1)?.outcome, "asked to confirm");
  sent.runner.confirm("merge");
  assert.equal(sent.runner.getState().transcripts.at(-1)?.outcome, "sent to Alpha");
  const timedOut = talkSetup();
  timedOut.runner.dispatch({ type: "utterance", text: "merge it" });
  await flush();
  timedOut.timers.at(-1)?.fn();
  assert.equal(timedOut.runner.getState().transcripts.at(-1)?.outcome, "cancelled");
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
