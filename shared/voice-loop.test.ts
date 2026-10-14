import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { addressed, initialVoiceState, step, withoutName, type VoiceEffect, type VoiceEvent, type VoiceMode, type VoiceSession, type VoiceState } from "./voice-loop";

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

test("shared/voice-loop.ts imports only its wording, and that imports nothing", () => {
  const source = readFileSync(new URL("./voice-loop.ts", import.meta.url), "utf8");
  const imports = source.match(/^\s*import\s.*$/gm) ?? [];
  assert.deepEqual(imports.map((line) => /from "([^"]+)"/.exec(line)?.[1]), ["./voice-lines", "./voice-names"]);
  assert.doesNotMatch(source, /\brequire\(/);
  for (const file of ["./voice-lines.ts", "./voice-names.ts"]) {
    const dep = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(dep, /^\s*import\s/m, file);
    assert.doesNotMatch(dep, /\brequire\(/, file);
  }
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
  for (const text of ["Jarvis, ignore me", "Jervis ignore me", "travis, ignoring me", "ignore me", "Hey Jarvis, ignore me", "Jarvis, silent mode", "silent mode"]) {
    const r = say(awake({ pending: { seq: 4, heard: "x" } }), text);
    assert.deepEqual(r.effects, [{ type: "sleep" }], text);
    assert.equal(r.state.mode, "asleep");
    assert.equal(r.state.pending, null);
  }
});

test("the sleep event puts an awake loop to sleep, stopping playback first when speaking, and clears everything", () => {
  const dirty = { talking: true, held: "docs: done", queue: [{ kind: "error" as const, sessionId: "s2", name: "docs" }] };
  const cases: [VoiceMode, Partial<VoiceState>, VoiceEffect[]][] = [
    ["listening", { pending: { seq: 2, heard: "x" } }, [{ type: "sleep" }]],
    ["confirming", { confirm: { word: "merge", text: "Merge it" } }, [{ type: "sleep" }]],
    ["speaking", {}, [{ type: "stopPlayback" }, { type: "sleep" }]],
  ];
  for (const [mode, patch, effects] of cases) {
    const r = step(awake({ mode, ...dirty, ...patch }), { type: "sleep" });
    assert.deepEqual(r.effects, effects, mode);
    assert.equal(r.state.mode, "asleep", mode);
    assert.equal(r.state.pending, null, mode);
    assert.equal(r.state.confirm, null, mode);
    assert.equal(r.state.talking, false, mode);
    assert.equal(r.state.held, null, mode);
    assert.deepEqual(r.state.queue, [], mode);
  }
});

test("the sleep event while asleep does nothing", () => {
  const asleep = awake({ mode: "asleep" });
  const r = step(asleep, { type: "sleep" });
  assert.deepEqual(r.effects, []);
  assert.deepEqual(r.state, asleep);
});

test("an utterance with no target asks for a session; otherwise it goes to the interpreter", () => {
  assert.deepEqual(say(awake({ session: null }), "fix the login bug").effects, [{ type: "speak", line: "Pick a session first. One, api-refactor. Two, docs. Say a number, or switch to and a name." }]);
  const r = say(awake(), "fix the login bug");
  assert.deepEqual(r.effects, [{ type: "interpret", seq: 1, text: "fix the login bug" }]);
  assert.deepEqual(r.state.pending, { seq: 1, heard: "fix the login bug" });
});

// Cycle 3
test("interpreted send steers the target and waits", () => {
  const r = heardAs(awake(), "fix the login bug", { type: "send", text: "Fix the login bug" });
  assert.deepEqual(r.effects, [{ type: "send", session: api, text: "Fix the login bug", behavior: "steer" }]);
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
    assert.ok(ask.type === "askConfirm" && ask.word === word && ask.line.includes("api-refactor") && ask.line.includes("Say one to send, or two to cancel."), heard);
  }
});

test("the exact word, spoken or confirm(word), sends; yes and other speech ask again", () => {
  const asked = heardAs(awake(), "merge it", { type: "send", text: "Merge the branch" }).state;
  const again = [{ type: "speak", line: "Say one to send, or two to cancel." }];
  assert.deepEqual(say(asked, "yes").effects, again);
  assert.deepEqual(say(asked, "fix the tests").effects, again);
  assert.equal(say(asked, "yes").state.confirm?.word, "merge", "still waiting");
  assert.deepEqual(step(asked, { type: "confirm", word: "delete" }).effects, []);
  const expected = [{ type: "send", session: api, text: "Merge the branch", behavior: "steer" }];
  const spoken = say(asked, "Jarvis, merge.");
  assert.deepEqual(spoken.effects, expected);
  assert.equal(spoken.state.mode, "waiting");
  assert.deepEqual(step(asked, { type: "confirm", word: "merge" }).effects, expected);
});

test("'one' sends and 'two' cancels a confirmation", () => {
  const asked = heardAs(awake(), "merge it", { type: "send", text: "Merge the branch" }).state;
  for (const yes of ["one", "Jarvis, one.", "1"]) assert.deepEqual(types(say(asked, yes).effects), ["send"], yes);
  for (const no of ["two", "Two.", "to", "2"]) {
    const r = say(asked, no);
    assert.deepEqual(r.effects, [{ type: "speak", line: "Cancelled." }], no);
    assert.equal(r.state.mode, "listening");
  }
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
  assert.deepEqual(r.effects, [{ type: "askConfirm", word: "send", line: 'Send "Rename the module" to api-refactor? Say one to send, or two to cancel.' }]);
  assert.equal(r.state.mode, "confirming");
});

// Cycle 5
test("only the interrupt event interrupts; a confirmed spoken 'stop' is steer text", () => {
  assert.deepEqual(step(awake({ mode: "waiting" }), { type: "interrupt" }).effects, [{ type: "interrupt", session: api }]);
  assert.deepEqual(step(awake({ session: null }), { type: "interrupt" }).effects, []);
  const asked = heardAs(awake(), "stop", { type: "send", text: "Stop" }).state;
  const r = say(asked, "stop");
  assert.deepEqual(types(r.effects), ["send"]);
  assert.equal(r.effects[0].type === "send" && r.effects[0].behavior, "steer");
});

// Cycle 6
test("a target reply is spoken as its first paragraph, with no session name; others are ignored", () => {
  const r = step(awake({ mode: "waiting" }), { type: "reply", sessionId: "s1", text: "## Done\n\n```ts\nconst a = 1;\n```\n\nThe **fix** is `in`. See [docs](http://x)." });
  assert.deepEqual(r.effects, [{ type: "speak", line: "Done" }]);
  assert.equal(r.state.mode, "speaking");
  const body = step(awake(), { type: "reply", sessionId: "s1", text: "```\ncode\n```\nThe **fix** is `in` _place_.\nSee [docs](http://x).\n\nSecond paragraph." });
  assert.deepEqual(body.effects, [{ type: "speak", line: "The fix is in place. See docs." }]);
  assert.deepEqual(step(awake(), { type: "reply", sessionId: "s2", text: "hello" }).effects, []);
  assert.deepEqual(step(awake({ talking: true }), { type: "reply", sessionId: "s1", text: "hello" }).effects, []);
});

test("a long reply is cut at a sentence end, else a word, at 300 characters", () => {
  const sentence = "This is a sentence of moderate length. ";
  const spoken = (text: string) => {
    const e = step(awake(), { type: "reply", sessionId: "s1", text }).effects[0];
    assert.equal(e.type, "speak");
    return e.type === "speak" ? e.line : "";
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
  assert.deepEqual(many.effects, [{ type: "speak", line: "Did you mean: one, api-refactor; two, api-docs? Say a number." }]);
  assert.equal(many.state.session, api);
  assert.deepEqual(say(known, "Jarvis, switch to billing").effects, [
    { type: "speak", line: "No session called billing. One, api-refactor. Two, docs. Three, api-docs. Say a number, or switch to and a name." },
  ]);
  const plain = say(known, "switch to strict mode");
  assert.deepEqual(types(plain.effects), ["interpret"], "a bare 'switch to' that names no session is a request for the session");
  assert.deepEqual(say(known, "switch to docs").effects, [{ type: "speak", line: "Now on docs." }]);
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
test("every mode × event: steers send with no receipt, only interrupt interrupts, asleep stays silent", () => {
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
      effects.forEach((e) => {
        if (e.type === "send") assert.equal(e.behavior, "steer", label);
        if (e.type === "interrupt") assert.equal(event.type, "interrupt", label);
      });
      // Asleep, only wake and words addressed to Jarvis do anything.
      const named = event.type === "utterance" && /^jarvis, (?!ignore)/i.test(event.text);
      if (mode === "asleep" && event.type !== "wake" && !named) assert.deepEqual(effects, [], label);
    }
  }
});

// Review fixes
test("a target reply that arrives while you talk or confirm waits, then is spoken", () => {
  const reply: VoiceEvent = { type: "reply", sessionId: "s1", text: "All done." };
  const talking = step(awake({ talking: true }), reply);
  assert.deepEqual(talking.effects, []);
  const done = say(talking.state, "uh");
  assert.deepEqual(done.effects, [{ type: "speak", line: "All done." }]);
  assert.equal(done.state.mode, "speaking");
  const confirming = step(awake({ mode: "confirming", confirm: { word: "merge", text: "x" } }), reply);
  assert.deepEqual(confirming.effects, []);
  const cancelled = step(confirming.state, { type: "confirm", word: "cancel" });
  assert.deepEqual(types(cancelled.effects), ["speak"]);
  const after = step(cancelled.state, { type: "playbackEnded" });
  assert.deepEqual(after.effects, [{ type: "speak", line: "All done." }]);
  const picked = step(talking.state, { type: "pick", session: docs });
  assert.deepEqual(say(picked.state, "uh").effects, [], "a held reply is dropped when you pick another session");
});

test("an empty utterance (noise) ends talking and lets queued notices out", () => {
  const queued = step(awake({ talking: true }), { type: "notice", kind: "error", sessionId: "s2" }).state;
  const r = say(queued, "");
  assert.equal(r.state.talking, false);
  assert.deepEqual(r.effects, [{ type: "speak", line: "Docs hit an error." }]);
});

test("notices from unknown sessions say 'A session' and merge by session id", () => {
  assert.deepEqual(step(awake(), { type: "notice", kind: "error", sessionId: "s9" }).effects, [{ type: "speak", line: "A session hit an error." }]);
  const twin: VoiceSession = { id: "s4", name: "docs" };
  let state = awake({ talking: true, sessions: [api, docs, twin] });
  for (const sessionId of ["s2", "s4"]) state = step(state, { type: "notice", kind: "finished", sessionId }).state;
  assert.deepEqual(say(state, "uh").effects, [{ type: "speak", line: "Two sessions finished." }]);
});

test("addressed spots a leading name; withoutName drops it and keeps the rest as said", () => {
  assert.equal(addressed("Jarvis, wake up"), true);
  assert.equal(addressed("hey Jervis"), true);
  assert.equal(addressed("run the tests"), false);
  assert.equal(withoutName("Jarvis, run the tests."), "run the tests.");
  assert.equal(withoutName("Hey Jarvis, Merge it"), "Merge it");
  assert.equal(withoutName("run the tests"), "run the tests");
  assert.equal(withoutName("Jarvis"), "Jarvis");
});

test("asleep, words that start with the name wake it; the rest is then heard as usual", () => {
  const asleep = { ...awake(), mode: "asleep" as const };
  const woke = say(asleep, "Jarvis, wake up");
  assert.deepEqual(woke.effects, [{ type: "listen" }, { type: "speak", line: "I'm listening." }]);
  assert.equal(woke.state.mode, "listening");
  assert.deepEqual(say(asleep, "Jarvis").effects, [{ type: "listen" }, { type: "speak", line: "I'm listening." }]);
  const ask = say(asleep, "Jarvis, run the tests");
  assert.deepEqual(types(ask.effects), ["listen", "interpret"]);
  assert.deepEqual(say(asleep, "Jarvis, ignore me").state.mode, "asleep");
  assert.deepEqual(say(asleep, "run the tests").effects, []);
});

test("Voice's own sessions are never a target: pick, switch by name, a stale target and a send are refused", () => {
  const jarvis: VoiceSession = { id: "j1", name: "Jarvis phone" };
  const line = "Jarvis phone is a voice session, so it can't be the target. Pick another session.";
  const state = awake({ blocked: [jarvis] });
  const picked = step(state, { type: "pick", session: jarvis });
  assert.deepEqual(picked.effects, [{ type: "speak", line }]);
  assert.equal(picked.state.session?.id, "s1");
  assert.deepEqual(step({ ...state, mode: "asleep" }, { type: "pick", session: jarvis }).state.session?.id, "s1");
  assert.deepEqual(say(state, "Jarvis, switch to jarvis phone").effects, [{ type: "speak", line }]);
  const dropped = step(awake({ session: jarvis }), { type: "sessions", list: [api, docs], blocked: [jarvis] });
  assert.equal(dropped.state.session, null);
  const sneaked = heardAs({ ...awake({ session: jarvis }), blocked: [jarvis] }, "run the tests", { type: "send", text: "run the tests" });
  assert.deepEqual(sneaked.effects, [{ type: "speak", line }]);
  assert.equal(sneaked.state.session, null);
});

test("'one' with nothing to confirm says so", () => {
  assert.deepEqual(say(awake(), "one").effects, [{ type: "speak", line: "Nothing to confirm." }]);
});

test("asleep, only the name itself wakes it, not a mishearing", () => {
  const asleep = { ...awake(), mode: "asleep" as const };
  for (const heard of ["Travis, wake up", "service the car", "Jervis", "javis run the tests"]) {
    assert.deepEqual(say(asleep, heard).effects, [], heard);
  }
  assert.equal(say(asleep, "OK Jarvis").state.mode, "listening");
  // Awake, the mishearings still count as the name.
  assert.deepEqual(say(awake(), "Travis, ignore me").effects, [{ type: "sleep" }]);
});

// Session picking, from real phone transcripts.
const phase: VoiceSession = { id: "p", name: "📐 Phase 1 architecture — Talk to a session hands-free" };
const check: VoiceSession = { id: "c", name: "Check" };
const s4: VoiceSession = { id: "s4", name: "🔁 S4 · Plan — Speak replies back" };
const s6: VoiceSession = { id: "s6", name: "🔁 S6 · Plan — Wire the helper into the Voice drawer" };
const spike: VoiceSession = { id: "v", name: "voice-spike throwaway" };
const phone = (patch: Partial<VoiceState> = {}) => awake({ session: null, sessions: [phase, check, s4, s6, spike], ...patch });
const PICK_FIRST = "Pick a session first. One, Phase 1 architecture. Two, Check. Three, S4 Plan. Four, S6 Plan. And more. Say a number, or switch to and a name.";

test("the phone transcripts: noise gets a short numbered list, 'Phase One architecture' finds 'Phase 1 architecture'", () => {
  let state = phone();
  for (const heard of ["Let's do this for.", "Which to ask for"]) {
    const r = say(state, heard);
    assert.deepEqual(r.effects, [{ type: "speak", line: PICK_FIRST }], heard);
    state = r.state;
  }
  const sport = say(state, "Switch to Sport Plan");
  assert.deepEqual(sport.effects, [{ type: "speak", line: "Did you mean: one, S4 Plan; two, S6 Plan? Say a number." }]);
  assert.equal(sport.state.session, null);
  const switched = say(sport.state, "Switch to Phase One architecture.");
  assert.deepEqual(switched.effects, [{ type: "speak", line: "Now on Phase 1 architecture." }]);
  assert.equal(switched.state.session, phase);
  const bare = say(phone(), "Phase One architecture.");
  assert.deepEqual(bare.effects, [{ type: "speak", line: "Now on Phase 1 architecture." }]);
  assert.equal(bare.state.session, phase);
});

test("a bare session name switches only when there is no target; with one it is just words for the target", () => {
  assert.equal(say(phone(), "Check").state.session, check);
  assert.equal(say(phone(), "S4 plan").state.session, s4);
  assert.deepEqual(say(phone(), "plan").effects, [], "a bare part of a name is not a name");
  const targeted = say(phone({ session: check }), "Phase One architecture.");
  assert.deepEqual(types(targeted.effects), ["interpret"]);
  assert.equal(targeted.state.session, check);
});

test("switch phrasings: switch to, go to, talk to, use, pick, open", () => {
  for (const heard of ["switch to check", "go to check", "talk to check", "use check", "pick check", "open check", "Jarvis, go to the check session please"]) {
    const r = say(phone({ session: s4 }), heard);
    assert.deepEqual(r.effects, [{ type: "speak", line: "Now on Check." }], heard);
    assert.equal(r.state.session, check, heard);
  }
  assert.deepEqual(types(say(phone({ session: s4 }), "open the voice file").effects), ["interpret"], "'open X' that is not exactly a session goes to the target");
  assert.deepEqual(say(phone(), "switch to billing").effects[0], { type: "speak", line: `No session called billing. ${PICK_FIRST.slice("Pick a session first. ".length)}` });
});

test("'list sessions' reads up to six short names, numbered; a bare number then picks one", () => {
  const many = [phase, check, s4, s6, spike, docs, api];
  for (const heard of ["list sessions", "which sessions", "what sessions are open", "sessions", "Jarvis, list the sessions"]) {
    const r = say(phone({ sessions: many, session: s4 }), heard);
    assert.deepEqual(
      r.effects,
      [{ type: "speak", line: "One, Phase 1 architecture. Two, Check. Three, S4 Plan. Four, S6 Plan. Five, voice-spike throwaway. Six, docs. And more. Say a number, or switch to and a name." }],
      heard,
    );
    assert.equal(r.state.choices?.length, 6);
  }
  const listed = say(phone(), "list sessions").state;
  for (const [heard, session] of [["two", check], ["2", check], ["number two", check], ["switch to two", check], ["the first one", phase], ["one", phase], ["third", s4]] as const) {
    const r = say(listed, heard);
    assert.equal(r.state.session, session, heard);
    assert.equal(r.state.choices, null, heard);
  }
  assert.deepEqual(say(listed, "nine").effects, [{ type: "speak", line: "There's no number nine. Say a number from one to five." }]);
  assert.equal(say(listed, "nine").state.choices?.length, 5, "a wrong number keeps the list");
  assert.equal(say(listed, "Which to ask for").state.choices?.length, 4, "a new list replaces it");
  assert.equal(say({ ...listed, session: check }, "run the tests please").state.choices, null, "anything else forgets it");
  assert.deepEqual(say(phone({ sessions: [] }), "list sessions").effects, [{ type: "speak", line: "No sessions are open." }]);
});

test("numbered answers pick from a did-you-mean and from pick-first", () => {
  const asked = say(phone(), "Switch to Sport Plan").state;
  assert.equal(say(asked, "one").state.session, s4);
  assert.equal(say(asked, "number two").state.session, s6);
  const first = say(phone(), "Let's do this for.").state;
  assert.deepEqual(say(first, "four").effects, [{ type: "speak", line: "Now on S6 Plan." }]);
});

test("a pending confirm beats a stale list: 'one' sends, 'two' cancels, the word said back still sends", () => {
  const listed = say(phone({ session: check }), "list sessions").state;
  const asking = heardAs(listed, "merge it", { type: "send", text: "merge it" });
  assert.deepEqual(asking.effects, [{ type: "askConfirm", word: "merge", line: 'Send "merge it" to Check? Say one to send, or two to cancel.' }]);
  assert.equal(asking.state.choices, null);
  for (const yes of ["one", "1", "number one", "merge"]) {
    const r = say(asking.state, yes);
    assert.deepEqual(types(r.effects), ["send"], yes);
    assert.equal(r.state.session, check, yes);
  }
  for (const no of ["two", "2", "number two", "too"]) assert.deepEqual(say(asking.state, no).effects, [{ type: "speak", line: "Cancelled." }], no);
  // A list stays with the sessions it was read from.
  const closed = step(listed, { type: "sessions", list: [check, s4] });
  assert.equal(closed.state.choices, null);
  assert.deepEqual(say(closed.state, "one").effects, [{ type: "speak", line: "Nothing to confirm." }]);
});

test("replies carry no session name; notices use the short name", () => {
  const on = say(phone(), "Phase One architecture.").state;
  const sent = heardAs(on, "run the tests", { type: "send", text: "run the tests" });
  assert.deepEqual(sent.effects, [{ type: "send", session: phase, text: "run the tests", behavior: "steer" }]);
  assert.deepEqual(step({ ...on, mode: "listening" }, { type: "reply", sessionId: "p", text: "Done." }).effects, [{ type: "speak", line: "Done." }]);
  assert.deepEqual(step(on, { type: "notice", kind: "needsYou", sessionId: "s4" }).effects, [{ type: "speak", line: "S4 Plan needs you." }]);
});

// S4 parity: the server feeds both loops a turn's reply and its finished notice together.
test("a finished turn's reply and notice: the target is read, another session is only announced, costCap merges", () => {
  const turn = (state: VoiceState, sessionId: string) =>
    [{ type: "reply", sessionId, text: "All done." }, { type: "notice", kind: "finished", sessionId }].reduce<{ state: VoiceState; spoken: string[] }>(
      (acc, event) => {
        const r = step(acc.state, event as VoiceEvent);
        return { state: r.state, spoken: [...acc.spoken, ...r.effects.flatMap((e) => (e.type === "speak" ? [e.line] : []))] };
      },
      { state: state, spoken: [] },
    );
  assert.deepEqual(turn(awake(), "s1").spoken, ["All done."]);
  assert.deepEqual(turn(awake(), "s2").spoken, ["Docs finished."]);
  const busy = awake({ mode: "confirming", confirm: { word: "merge", text: "x" }, sessions: [api, docs, apiTwo] });
  const held = turn(busy, "s1");
  assert.deepEqual(held.spoken, []);
  assert.equal(held.state.held, "All done.");
  const capped = ["s2", "s3"].reduce((s, sessionId) => step(s, { type: "notice", kind: "costCap", sessionId }).state, awake({ talking: true, sessions: [api, docs, apiTwo] }));
  assert.deepEqual(say(capped, "uh").effects, [{ type: "speak", line: "Two sessions hit the cost cap." }]);
});

// Review fixes: strict confirms, numbers that belong to the target, noise and stale lists.
test("a confirm sends only on an exact one, number one or the word said back; anything else asks again", () => {
  const asking = heardAs(awake(), "merge it", { type: "send", text: "merge it" }).state;
  for (const loose of ["won", "first", "the one", "number one please", "the first one", "option one", "yes", "uh"]) {
    const r = say(asking, loose);
    assert.deepEqual(r.effects, [{ type: "speak", line: "Say one to send, or two to cancel." }], loose);
    assert.equal(r.state.mode, "confirming", loose);
  }
  for (const yes of ["one", "1", "number one", "One.", "merge"]) assert.deepEqual(types(say(asking, yes).effects), ["send"], yes);
  for (const no of ["two", "2", "number two", "never mind"]) assert.deepEqual(say(asking, no).effects, [{ type: "speak", line: "Cancelled." }], no);
});

test("with a target and nothing pending, only a bare 'one' gets 'Nothing to confirm'; numbered speech goes to the target", () => {
  for (const bare of ["one", "1", "One."]) assert.deepEqual(say(awake(), bare).effects, [{ type: "speak", line: "Nothing to confirm." }], bare);
  for (const heard of ["option one", "the first one", "pick one", "number one please"]) {
    assert.deepEqual(types(say(awake(), heard).effects), ["interpret"], heard);
  }
});

test("a list ignores sound-alikes, expires, and is forgotten by any other words; its own echo picks nothing", () => {
  const listed = say(awake({ sessions: [api, docs, apiTwo] }), "list sessions").state;
  for (const noise of ["to", "too", "for", "won"]) {
    const r = say(listed, noise);
    assert.equal(r.state.session, api, noise);
    assert.equal(r.state.choices, null, noise);
  }
  const expired = step(listed, { type: "choicesExpired" });
  assert.deepEqual(expired.effects, []);
  assert.equal(say(expired.state, "two").state.session, api, "an expired list picks nothing");
  // Jarvis hearing its own list read back.
  const echo = say(listed, "Two, docs.");
  assert.equal(echo.state.session, api);
  assert.equal(echo.state.choices, null);
  assert.deepEqual(types(echo.effects), ["interpret"]);
  const noTarget = say({ ...listed, session: null }, "Two, docs.");
  assert.equal(noTarget.state.session, null);
});

// S16 Cycle 4
test("'new session' with a target creates a voice session in its workspace; with none it asks to pick first", () => {
  for (const heard of ["new session", "start a new session", "Jarvis, new session", "Jarvis, start a new session"]) {
    const r = say(awake(), heard);
    assert.deepEqual(r.effects, [{ type: "create", session: api }, { type: "speak", line: "Starting a voice session in api-refactor." }], heard);
  }
  const none = say(awake({ session: null }), "new session");
  assert.deepEqual(types(none.effects), ["speak"]);
  assert.ok(none.effects[0].type === "speak" && none.effects[0].line.startsWith("Pick a session first."));
});

// S19: a session on the Speak pill is heard on the phone, whoever the target is.
const watchedReply = (sessionId: string, text = "All done."): VoiceEvent => ({ type: "reply", sessionId, text, watched: true });
const lines = (effects: VoiceEffect[]) => effects.flatMap((e) => (e.type === "speak" ? [e.line] : []));

test("a watched reply from another session is spoken as '<name>: <first paragraph>'", () => {
  const r = step(awake(), watchedReply("s2", "## Done\n\nThe **fix** is `in`. See [docs](http://x).\n\nSecond."));
  assert.deepEqual(r.effects, [{ type: "speak", line: "docs: Done" }]);
  const heard = step(awake(), watchedReply("s2", "The **fix** is `in`. See [docs](http://x).\n\nSecond."));
  assert.deepEqual(heard.effects, [{ type: "speak", line: "docs: The fix is in. See docs." }]);
});

test("an unwatched reply from another session is still silent; a watched reply from the target is a normal reply", () => {
  assert.deepEqual(step(awake(), { type: "reply", sessionId: "s2", text: "hi" }).effects, []);
  assert.deepEqual(step(awake(), watchedReply("s1")).effects, [{ type: "speak", line: "All done." }]);
});

test("a watched reply is cut at 300 characters and a code-only one says nothing", () => {
  const long = "Word ".repeat(100);
  const [line] = lines(step(awake(), watchedReply("s2", long)).effects);
  assert.ok(line.startsWith("docs: Word") && line.length <= "docs: ".length + 300, String(line.length));
  assert.deepEqual(step(awake(), watchedReply("s2", "```\ncode\n```")).effects, []);
});

test("watched replies wait while you talk, confirm or are spoken to, then go out as one line with the notices", () => {
  const three = { sessions: [api, docs, apiTwo] };
  for (const busy of [awake({ talking: true, ...three }), awake({ mode: "confirming", confirm: { word: "merge", text: "x" }, ...three }), awake({ mode: "speaking", ...three })]) {
    const first = step(busy, watchedReply("s2", "Tests pass."));
    assert.deepEqual(first.effects, [], busy.mode);
    const both = step(first.state, watchedReply("s3", "Docs built."));
    const withNotice = step(both.state, { type: "notice", kind: "needsYou", sessionId: "s1" });
    const out = busy.mode === "speaking" ? step(withNotice.state, { type: "playbackEnded" }) : busy.talking ? say(withNotice.state, "uh") : step(step(withNotice.state, { type: "confirm", word: "cancel" }).state, { type: "playbackEnded" });
    const said = lines(out.effects).join(" ");
    assert.match(said, /docs: Tests pass\. api-docs: Docs built\./, busy.mode);
    assert.equal(lines(out.effects).filter((l) => /Tests pass/.test(l)).length, 1, "one line, not two");
  }
});

test("sleep clears queued watched replies", () => {
  const queued = step(awake({ talking: true }), watchedReply("s2")).state;
  assert.deepEqual(step(queued, { type: "sleep" }).state.heard, []);
});

test("asleep, a watched reply does nothing", () => {
  assert.deepEqual(step({ ...initialVoiceState(), sessions: [docs] }, watchedReply("s2")).effects, []);
});
