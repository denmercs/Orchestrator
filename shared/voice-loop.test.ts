import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { initialVoiceState, step, type VoiceEffect, type VoiceEvent, type VoiceMode, type VoiceSession, type VoiceState } from "./voice-loop";

const api: VoiceSession = { id: "s1", name: "api-refactor" };
const docs: VoiceSession = { id: "s2", name: "docs" };
const apiTwo: VoiceSession = { id: "s3", name: "api-docs" };

const awake = (patch: Partial<VoiceState> = {}): VoiceState => ({ ...initialVoiceState(), mode: "listening", session: api, sessions: [api, docs], ...patch });
const say = (state: VoiceState, text: string) => step(state, { type: "utterance", text });
const types = (effects: VoiceEffect[]) => effects.map((e) => e.type);

/** Runs an utterance through the interpreter stub (echo) and returns the step after `interpreted`. */
const heardAs = (state: VoiceState, text: string, result: { type: "send"; text: string } | { type: "confirm"; text: string }) => {
  const first = say(state, text);
  const seq = first.state.pending?.seq ?? -1;
  return step(first.state, { type: "interpreted", seq, result });
};

// Cycle 1
test("the loop starts asleep; wake listens; everything else while asleep does nothing", () => {
  const start = initialVoiceState();
  assert.equal(start.mode, "asleep");
  assert.deepEqual(step(start, { type: "wake" }).effects, [{ type: "listen" }]);
  assert.equal(step(start, { type: "wake" }).state.mode, "listening");
  const events: VoiceEvent[] = [
    { type: "speechStart" },
    { type: "utterance", text: "hello there" },
    { type: "interpreted", seq: 1, result: { type: "drop" } },
    { type: "reply", sessionId: "s1", text: "hi" },
    { type: "playbackEnded" },
    { type: "confirm", word: "merge" },
    { type: "notice", kind: "finished", sessionId: "s2" },
    { type: "interrupt" },
  ];
  for (const event of events) assert.deepEqual(step({ ...start, session: api }, event).effects, [], event.type);
  const picked = step(start, { type: "pick", session: docs });
  assert.deepEqual(picked.effects, []);
  assert.equal(picked.state.mode, "asleep");
  assert.equal(picked.state.session, docs);
});

test("shared/voice-loop.ts has no import lines", () => {
  const source = readFileSync(new URL("./voice-loop.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\brequire\(/);
});

// Cycle 2
test("fragments produce no effect", () => {
  for (const text of ["uh", "Jarvis", "hmm."]) assert.deepEqual(say(awake(), text).effects, [], text);
});

test("'never mind' is matched locally and never reaches the interpreter", () => {
  const r = say(awake(), "Never mind.");
  assert.deepEqual(r.effects, []);
});

test("'Jarvis, ignore me' and close mishearings put the loop to sleep", () => {
  for (const text of ["Jarvis, ignore me", "Jervis ignore me", "travis, ignoring me", "ignore me"]) {
    const r = say(awake({ pending: { seq: 4, heard: "x" } }), text);
    assert.deepEqual(r.effects, [{ type: "sleep" }], text);
    assert.equal(r.state.mode, "asleep");
    assert.equal(r.state.pending, null);
  }
});

test("an utterance with no target asks for a session; otherwise it goes to the interpreter", () => {
  assert.deepEqual(say(awake({ session: null }), "fix the login bug").effects, [{ type: "speak", line: "Pick a session first." }]);
  const r = say(awake(), "fix the login bug");
  assert.deepEqual(r.effects, [{ type: "interpret", seq: 1, text: "fix the login bug" }]);
  assert.deepEqual(r.state.pending, { seq: 1, heard: "fix the login bug" });
});

// Cycle 3
test("interpreted send steers the target, gives a receipt and waits", () => {
  const r = heardAs(awake(), "fix the login bug", { type: "send", text: "Fix the login bug" });
  assert.deepEqual(r.effects, [
    { type: "send", session: api, text: "Fix the login bug", behavior: "steer" },
    { type: "receipt", session: api, line: "Sent to api-refactor" },
  ]);
  assert.equal(r.state.mode, "waiting");
  assert.equal(r.state.pending, null);
});

test("interpreted drop does nothing, and a stale seq is ignored", () => {
  const asked = say(awake(), "fix the login bug");
  assert.deepEqual(step(asked.state, { type: "interpreted", seq: 1, result: { type: "drop" } }).effects, []);
  const stale = step(asked.state, { type: "interpreted", seq: 9, result: { type: "send", text: "x" } });
  assert.deepEqual(stale.effects, []);
  assert.equal(stale.state.pending?.seq, 1);
});

test("'never mind' while an interpretation is pending makes the later result stale", () => {
  const asked = say(awake(), "fix the login bug");
  const cancelled = say(asked.state, "never mind");
  assert.deepEqual(cancelled.effects, []);
  assert.deepEqual(step(cancelled.state, { type: "interpreted", seq: 1, result: { type: "send", text: "Fix it" } }).effects, []);
});

// Cycle 4
test("a critical word asks for confirmation naming the session and the word, and never sends", () => {
  for (const [heard, cleaned, word] of [
    ["please merge the branch", "Merge the branch", "merge"],
    ["wrap this up", "Delete the old files", "delete"],
    ["Stop the build now", "Halt the build", "stop"],
  ]) {
    const r = heardAs(awake(), heard, { type: "send", text: cleaned });
    assert.deepEqual(types(r.effects), ["askConfirm"], heard);
    assert.equal(r.state.mode, "confirming");
    const ask = r.effects[0];
    assert.ok(ask.type === "askConfirm" && ask.word === word && ask.line.includes("api-refactor") && ask.line.includes(word), heard);
  }
});

test("the exact word, spoken or confirm(word), sends with a receipt; yes and other speech do nothing", () => {
  const asked = heardAs(awake(), "merge it", { type: "send", text: "Merge the branch" }).state;
  assert.deepEqual(say(asked, "yes").effects, []);
  assert.deepEqual(say(asked, "fix the tests").effects, []);
  assert.deepEqual(step(asked, { type: "confirm", word: "delete" }).effects, []);
  const expected = [
    { type: "send", session: api, text: "Merge the branch", behavior: "steer" },
    { type: "receipt", session: api, line: "Sent to api-refactor" },
  ];
  const spoken = say(asked, "Jarvis, merge.");
  assert.deepEqual(spoken.effects, expected);
  assert.equal(spoken.state.mode, "waiting");
  assert.deepEqual(step(asked, { type: "confirm", word: "merge" }).effects, expected);
});

test("'never mind' and confirm(cancel) cancel a confirmation", () => {
  const asked = heardAs(awake(), "merge it", { type: "send", text: "Merge the branch" }).state;
  for (const r of [say(asked, "never mind"), step(asked, { type: "confirm", word: "cancel" })]) {
    assert.deepEqual(r.effects, [{ type: "speak", line: "Cancelled." }]);
    assert.equal(r.state.mode, "listening");
    assert.equal(r.state.confirm, null);
  }
});

test("interpreted confirm(text) asks even without a critical word", () => {
  const r = heardAs(awake(), "rename the module", { type: "confirm", text: "Rename the module" });
  assert.deepEqual(r.effects, [{ type: "askConfirm", word: "send", line: 'Send "Rename the module" to api-refactor? Say send to confirm.' }]);
  assert.equal(r.state.mode, "confirming");
});

// Cycle 5
test("only the interrupt event interrupts; a confirmed spoken 'stop' is steer text", () => {
  assert.deepEqual(step(awake({ mode: "waiting" }), { type: "interrupt" }).effects, [{ type: "interrupt", session: api }]);
  assert.deepEqual(step(awake({ session: null }), { type: "interrupt" }).effects, []);
  const asked = heardAs(awake(), "stop", { type: "send", text: "Stop" }).state;
  const r = say(asked, "stop");
  assert.deepEqual(types(r.effects), ["send", "receipt"]);
  assert.equal(r.effects[0].type === "send" && r.effects[0].behavior, "steer");
});

// Cycle 6
test("a target reply is spoken as '<name>: <first paragraph>'; others are ignored", () => {
  const r = step(awake({ mode: "waiting" }), { type: "reply", sessionId: "s1", text: "## Done\n\n```ts\nconst a = 1;\n```\n\nThe **fix** is `in`. See [docs](http://x)." });
  assert.deepEqual(r.effects, [{ type: "speak", line: "api-refactor: Done" }]);
  assert.equal(r.state.mode, "speaking");
  const body = step(awake(), { type: "reply", sessionId: "s1", text: "```\ncode\n```\nThe **fix** is `in` _place_.\nSee [docs](http://x).\n\nSecond paragraph." });
  assert.deepEqual(body.effects, [{ type: "speak", line: "api-refactor: The fix is in place. See docs." }]);
  assert.deepEqual(step(awake(), { type: "reply", sessionId: "s2", text: "hello" }).effects, []);
  assert.deepEqual(step(awake({ talking: true }), { type: "reply", sessionId: "s1", text: "hello" }).effects, []);
});

test("a long reply is cut at a sentence end, else a word, at 300 characters", () => {
  const sentence = "This is a sentence of moderate length. ";
  const spoken = (text: string) => {
    const e = step(awake(), { type: "reply", sessionId: "s1", text }).effects[0];
    assert.equal(e.type, "speak");
    return e.type === "speak" ? e.line.replace("api-refactor: ", "") : "";
  };
  const a = spoken(sentence.repeat(20));
  assert.ok(a.length <= 300 && a.endsWith("."), a);
  const b = spoken("word ".repeat(100));
  assert.ok(b.length <= 301 && b.endsWith("…"), b);
});

test("playbackEnded returns to listening and speechStart while speaking only stops playback", () => {
  const speaking = awake({ mode: "speaking" });
  assert.equal(step(speaking, { type: "playbackEnded" }).state.mode, "listening");
  const r = step(speaking, { type: "speechStart" });
  assert.deepEqual(r.effects, [{ type: "stopPlayback" }]);
  assert.equal(r.state.mode, "listening");
});

// Cycle 7
test("finished, needsYou, error and costCap speak; progress does not; the target's own finished is dropped", () => {
  for (const [kind, line] of [
    ["finished", "Docs finished."],
    ["needsYou", "Docs needs you."],
    ["error", "Docs hit an error."],
    ["costCap", "Docs hit the cost cap."],
  ]) {
    assert.deepEqual(step(awake(), { type: "notice", kind, sessionId: "s2" }).effects, [{ type: "speak", line }], kind);
  }
  assert.deepEqual(step(awake(), { type: "notice", kind: "progress", sessionId: "s2" }).effects, []);
  assert.deepEqual(step(awake(), { type: "notice", kind: "finished", sessionId: "s1" }).effects, []);
});

test("notices queue while talking, speaking or confirming, merge, and flush afterwards", () => {
  const notices: VoiceEvent[] = [
    { type: "notice", kind: "finished", sessionId: "s2" },
    { type: "notice", kind: "finished", sessionId: "s3" },
    { type: "notice", kind: "needsYou", sessionId: "s2" },
  ];
  for (const patch of [{ talking: true }, { mode: "speaking" as VoiceMode }, { mode: "confirming" as VoiceMode, confirm: { word: "merge", text: "x" } }]) {
    let state = awake({ ...patch, sessions: [api, docs, apiTwo] });
    for (const n of notices) {
      const r = step(state, n);
      assert.deepEqual(r.effects, []);
      state = r.state;
    }
    assert.equal(state.queue.length, 3);
  }
  const talking = awake({ talking: true, sessions: [api, docs, apiTwo] });
  const queued = notices.reduce((s, n) => step(s, n).state, talking);
  const flushed = say(queued, "uh");
  assert.deepEqual(flushed.effects, [{ type: "speak", line: "Two sessions finished. docs needs you." }]);
  assert.equal(flushed.state.mode, "speaking");
  assert.deepEqual(flushed.state.queue, []);
  const afterSpeech = step(awake({ mode: "speaking", queue: queued.queue }), { type: "playbackEnded" });
  assert.deepEqual(types(afterSpeech.effects), ["speak"]);
});

test("asleep drops notices", () => {
  const r = step({ ...awake(), mode: "asleep" }, { type: "notice", kind: "error", sessionId: "s2" });
  assert.deepEqual(r.effects, []);
  assert.deepEqual(r.state.queue, []);
});

// Cycle 8
test("pick resets to listening for the new session from every awake mode and keeps the queue", () => {
  const queue = [{ kind: "finished" as const, sessionId: "s2", name: "docs" }];
  for (const mode of ["listening", "confirming", "waiting", "speaking"] as VoiceMode[]) {
    const r = step(awake({ mode, queue, talking: true, pending: { seq: 1, heard: "x" }, confirm: mode === "confirming" ? { word: "merge", text: "x" } : null }), { type: "pick", session: docs });
    assert.deepEqual(r.effects, mode === "speaking" ? [{ type: "stopPlayback" }] : [], mode);
    assert.equal(r.state.mode, "listening");
    assert.equal(r.state.session, docs);
    assert.equal(r.state.pending, null);
    assert.equal(r.state.confirm, null);
    assert.deepEqual(r.state.queue, queue);
  }
});

test("'Jarvis, switch to <name>' picks the match, asks when several match, and reports none", () => {
  const known = awake({ sessions: [api, docs, apiTwo] });
  const one = say(known, "Jarvis, switch to docs");
  assert.deepEqual(one.effects, [{ type: "speak", line: "Now on docs." }]);
  assert.equal(one.state.session, docs);
  const partial = say(awake({ sessions: [api, docs] }), "Jarvis, switch to api");
  assert.deepEqual(partial.effects, [{ type: "speak", line: "Now on api-refactor." }]);
  assert.equal(partial.state.session, api);
  const many = say(known, "Jarvis, switch to api");
  assert.deepEqual(many.effects, [{ type: "speak", line: "Which one: api-refactor or api-docs?" }]);
  assert.equal(many.state.session, api);
  assert.deepEqual(say(known, "switch to billing").effects, [{ type: "speak", line: "No session called billing." }]);
  const viaHelper = heardAs(known, "go to the docs one", { type: "send", text: "x" });
  assert.ok(viaHelper.effects.length > 0);
  const asked = say(known, "take me to docs");
  const switched = step(asked.state, { type: "interpreted", seq: asked.state.pending?.seq ?? -1, result: { type: "switch", name: "docs" } });
  assert.deepEqual(switched.effects, [{ type: "speak", line: "Now on docs." }]);
  assert.equal(switched.state.session, docs);
});

test("the sessions event only updates the list", () => {
  const r = step(awake(), { type: "sessions", list: [docs] });
  assert.deepEqual(r.effects, []);
  assert.deepEqual(r.state.sessions, [docs]);
});

// Cycle 9
test("every mode × event: steers pair with receipts, only interrupt interrupts, asleep stays silent", () => {
  const modes: VoiceMode[] = ["asleep", "listening", "confirming", "waiting", "speaking"];
  const events: VoiceEvent[] = [
    { type: "wake" },
    { type: "speechStart" },
    { type: "utterance", text: "fix the login bug" },
    { type: "utterance", text: "merge it" },
    { type: "utterance", text: "stop" },
    { type: "utterance", text: "merge" },
    { type: "utterance", text: "never mind" },
    { type: "utterance", text: "Jarvis, ignore me" },
    { type: "utterance", text: "Jarvis, switch to docs" },
    { type: "interpreted", seq: 1, result: { type: "send", text: "Fix the login bug" } },
    { type: "interpreted", seq: 1, result: { type: "send", text: "Merge the branch" } },
    { type: "interpreted", seq: 1, result: { type: "confirm", text: "Rename it" } },
    { type: "interpreted", seq: 1, result: { type: "switch", name: "docs" } },
    { type: "interpreted", seq: 1, result: { type: "drop" } },
    { type: "reply", sessionId: "s1", text: "All done." },
    { type: "playbackEnded" },
    { type: "confirm", word: "merge" },
    { type: "confirm", word: "cancel" },
    { type: "pick", session: docs },
    { type: "sessions", list: [api, docs] },
    { type: "notice", kind: "finished", sessionId: "s2" },
    { type: "notice", kind: "progress", sessionId: "s2" },
    { type: "interrupt" },
  ];
  for (const mode of modes) {
    const state = awake({
      mode,
      pending: mode === "listening" || mode === "waiting" ? { seq: 1, heard: "merge it" } : null,
      confirm: mode === "confirming" ? { word: "merge", text: "Merge the branch" } : null,
    });
    for (const event of events) {
      const label = `${mode} × ${event.type}${"text" in event ? `(${event.text})` : ""}`;
      const { effects } = step(state, event);
      effects.forEach((e, i) => {
        if (e.type === "send") {
          assert.equal(e.behavior, "steer", label);
          const receipt = effects[i + 1];
          assert.ok(receipt?.type === "receipt" && receipt.session.id === e.session.id, label);
          const words = receipt.type === "receipt" ? receipt.line.split(" ").length : 0;
          assert.ok(words >= 2 && words <= 5 && receipt.type === "receipt" && receipt.line.includes(e.session.name), label);
        }
        if (e.type === "interrupt") assert.equal(event.type, "interrupt", label);
      });
      if (mode === "asleep" && event.type !== "wake") assert.deepEqual(effects, [], label);
    }
  }
});
