import assert from "node:assert/strict";
import { test } from "node:test";
import { choiceNumber, exactSessions, matchSessions, nameTokens, shortName } from "./voice-names";

const phase = { id: "p", name: "📐 Phase 1 architecture — Talk to a session hands-free" };
const check = { id: "c", name: "Check" };
const s4 = { id: "s4", name: "🔁 S4 · Plan — Speak replies back" };
const s6 = { id: "s6", name: "🔁 S6 · Plan — Wire the helper into the Voice drawer" };
const spike = { id: "v", name: "voice-spike throwaway" };
const all = [phase, check, s4, s6, spike];
const ids = (list: { id: string }[]) => list.map((s) => s.id);

test("short names drop emoji, symbols and everything after a dash separator", () => {
  assert.deepEqual(all.map((s) => shortName(s.name)), ["Phase 1 architecture", "Check", "S4 Plan", "S6 Plan", "voice-spike throwaway"]);
  assert.equal(shortName("api-refactor"), "api-refactor");
  assert.equal(shortName("one two three four five six seven eight"), "one two three four five six");
  assert.equal(shortName("📐"), "📐", "a title with nothing speakable stays as it was");
});

test("name words are lowercase, number words become digits, filler words go", () => {
  assert.deepEqual(nameTokens("Switch the Phase One session, please!"), ["switch", "phase", "1"]);
  assert.deepEqual(nameTokens("the first draft"), ["1", "draft"]);
  assert.deepEqual(nameTokens("📐 Phase 1 · architecture —"), ["phase", "1", "architecture"]);
});

test("matching: exact or short name, then all words in the title, then a clear best overlap", () => {
  assert.deepEqual(ids(matchSessions(all, "Phase One architecture.")), ["p"]);
  assert.deepEqual(ids(matchSessions(all, "phase one")), ["p"], "words contained in the title");
  assert.deepEqual(ids(matchSessions(all, "phaze one architecure")), ["p"], "one slip per long word");
  assert.deepEqual(ids(matchSessions(all, "check")), ["c"]);
  assert.deepEqual(ids(matchSessions(all, "S4 plan")), ["s4"]);
  assert.deepEqual(ids(matchSessions(all, "plan")), ["s4", "s6"], "ambiguous");
  assert.deepEqual(ids(matchSessions(all, "Sport Plan")), ["s4", "s6"], "best overlap ties: ask");
  assert.deepEqual(ids(matchSessions(all, "Sport Plan", false)), [], "strict: no overlap guesses");
  assert.deepEqual(ids(matchSessions(all, "voice drawer plan")), ["s6"]);
  assert.deepEqual(ids(matchSessions(all, "billing")), []);
  assert.deepEqual(ids(matchSessions(all, "the session")), [], "only filler matches nothing");
  assert.deepEqual(ids(matchSessions(all, "chek")), ["c"], "one slip in a word of four letters or more");
  assert.deepEqual(ids(matchSessions(all, "s5 plan", false)), [], "words under four letters must be exact");
});

test("an exact name is the whole full or short name, word for word", () => {
  assert.deepEqual(ids(exactSessions(all, "Phase One architecture")), ["p"]);
  assert.deepEqual(ids(exactSessions(all, "Check.")), ["c"]);
  assert.deepEqual(ids(exactSessions(all, "phase one")), []);
  assert.deepEqual(ids(exactSessions(all, "Let's do this for.")), []);
});

test("numbered answers: words, digits and ordinals, never a sound-alike", () => {
  const cases: [string, number | null][] = [
    ["one", 1], ["1", 1], ["number one", 1], ["the first one", 1], ["first", 1], ["1st", 1],
    ["two", 2], ["number 2", 2], ["to", null], ["too", null], ["for", null], ["won", null], ["switch to two", 2], ["pick three", 3], ["the third", 3], ["option four", 4], ["six please", 6],
    ["Phase One architecture", null], ["check", null], ["switch to check", null], ["zero", null], ["", null],
  ];
  for (const [text, n] of cases) assert.equal(choiceNumber(text), n, text);
});
