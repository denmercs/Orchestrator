import assert from "node:assert/strict";
import { test } from "node:test";
import { createDictation, DICTATION_PAUSE_MS, unsent } from "./dictation-model";

function setup(accept = true) {
  const sent: string[] = [];
  let clears = 0;
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const dictation = createDictation({
    send: (text) => (sent.push(text), accept),
    clear: () => void clears++,
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
  const live = () => timers.filter((t) => !t.cleared);
  const pause = () => live().forEach((t) => ((t.cleared = true), t.fn()));
  return { dictation, sent, clears: () => clears, timers, live, pause };
}

test("unsent drops a re-inserted copy of the last send and trims", () => {
  assert.equal(unsent("  run the tests ", ""), "run the tests");
  assert.equal(unsent("run the tests and lint", "run the tests"), "and lint");
  assert.equal(unsent("one", "one"), "one");
  assert.equal(unsent("  ", ""), "");
});

test("text that stays unchanged for the pause is sent and the box cleared", () => {
  const { dictation, sent, clears, timers, pause } = setup();
  dictation.change("run the");
  dictation.change("run the tests");
  assert.equal(timers.at(-1)?.ms, DICTATION_PAUSE_MS);
  assert.deepEqual(sent, []);
  pause();
  assert.deepEqual(sent, ["run the tests"]);
  assert.equal(clears(), 1);
});

test("an edit mid-pause restarts the wait and sends only the settled text", () => {
  const { dictation, sent, timers, pause } = setup();
  dictation.change("run the tests");
  const first = timers.at(-1);
  dictation.change("run the unit tests");
  assert.equal(first?.cleared, true);
  pause();
  assert.deepEqual(sent, ["run the unit tests"]);
});

test("empty or whitespace is never sent and starts no timer", () => {
  const { dictation, sent, live } = setup();
  dictation.change("   ");
  assert.equal(live().length, 0);
  assert.equal(dictation.send(), false);
  dictation.change("run it");
  dictation.change("");
  assert.equal(live().length, 0);
  assert.deepEqual(sent, []);
});

test("the Send button sends at once and cancels the pending pause, so nothing goes twice", () => {
  const { dictation, sent, timers } = setup();
  dictation.change("run the tests");
  assert.equal(dictation.send(), true);
  assert.equal(timers.at(-1)?.cleared, true);
  assert.equal(dictation.send(), false);
  assert.deepEqual(sent, ["run the tests"]);
});

test("a keyboard that puts the last send back only sends the new words", () => {
  const { dictation, sent, pause } = setup();
  dictation.change("run the tests");
  pause();
  dictation.change("run the tests and");
  dictation.change("run the tests and lint");
  pause();
  assert.deepEqual(sent, ["run the tests", "and lint"]);
});

test("after the keyboard starts afresh, the same words can be sent again", () => {
  const { dictation, sent, pause } = setup();
  dictation.change("one");
  pause();
  dictation.change("o");
  dictation.change("x");
  dictation.change("one");
  pause();
  assert.deepEqual(sent, ["one", "one"]);
});

test("auto-send off waits for the button; turning it back on picks up what is waiting", () => {
  const { dictation, sent, live, pause } = setup();
  dictation.setAuto(false);
  dictation.change("run the tests");
  assert.equal(live().length, 0);
  dictation.setAuto(true);
  assert.equal(live().length, 1);
  pause();
  assert.deepEqual(sent, ["run the tests"]);
});

test("a refused send keeps the box, and dispose stops the timer", () => {
  const { dictation, clears, live } = setup(false);
  dictation.change("run the tests");
  assert.equal(dictation.send(), false);
  assert.equal(clears(), 0);
  dictation.change("run the tests now");
  dictation.dispose();
  assert.equal(live().length, 0);
});
