import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDebriefNotes, DEBRIEF_NOTES_FORMAT, debriefNotes } from "./debrief-notes";

const valid = {
  version: 1,
  summary: "Adds the renderer.",
  stops: [{ file: "server/a.ts", line: 3, why: "Entry point." }],
  notes: [
    { kind: "decision", file: "server/a.ts", line: 5, text: "Chose X.", rejected: "Y, because Z." },
    { kind: "watch", file: "server/a.ts", line: 9, text: "Check this." },
  ],
  boxes: [{ id: "server/a.ts#run", label: "Run", scenario: "run > works" }],
  built: [{ text: "Page renderer.", file: "server/a.ts" }],
};

test("debriefNotes accepts a valid version 1 file", () => {
  assert.equal(debriefNotes.safeParse(valid).success, true);
});

test("debriefNotes rejects a decision with no rejected, a bad kind and version 2", () => {
  const decision = { kind: "decision", file: "a.ts", line: 1, text: "Chose X." };
  assert.equal(debriefNotes.safeParse({ ...valid, notes: [decision] }).success, false);
  assert.equal(debriefNotes.safeParse({ ...valid, notes: [{ ...decision, kind: "idea" }] }).success, false);
  assert.equal(debriefNotes.safeParse({ ...valid, version: 2 }).success, false);
});

test("DEBRIEF_NOTES_FORMAT tells the Debrief agent the rules", () => {
  for (const phrase of ["rejected", "#", "describe > test", "at most 5"]) {
    assert.ok(DEBRIEF_NOTES_FORMAT.includes(phrase), phrase);
  }
});

const lines = (file: string) => ({ "server/a.ts": 20, "server/b.ts": 5 })[file];
const stop = (n: number) => ({ file: "server/a.ts", line: n, why: `Stop ${n}.` });

test("checkDebriefNotes turns a non-object or wrong version into one problem and no notes", () => {
  for (const raw of ["nope", null, { ...valid, version: 2 }]) {
    const { notes, problems } = checkDebriefNotes(raw, lines);
    assert.equal(notes, null);
    assert.equal(problems.length, 1);
  }
});

test("checkDebriefNotes drops one bad note and keeps the rest", () => {
  const bad = { kind: "decision", file: "server/a.ts", line: 2, text: "No rejected." };
  const { notes, problems } = checkDebriefNotes({ ...valid, notes: [valid.notes[1], bad, valid.notes[0]] }, lines);
  assert.deepEqual(notes?.notes, [valid.notes[1], valid.notes[0]]);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /^notes\[1\]: /);
});

test("checkDebriefNotes keeps the first 5 stops with one line", () => {
  const { notes, problems } = checkDebriefNotes({ ...valid, stops: [1, 2, 3, 4, 5, 6, 7].map(stop) }, lines);
  assert.deepEqual(notes?.stops.map((s) => s.line), [1, 2, 3, 4, 5]);
  assert.deepEqual(problems, ["stops: 7 given, kept the first 5"]);
});

test("checkDebriefNotes drops a stop past the end of its file or on a file it doesn't know", () => {
  const stops = [stop(20), stop(21), { file: "server/gone.ts", line: 1, why: "Deleted." }];
  const { notes, problems } = checkDebriefNotes({ ...valid, stops }, lines);
  assert.deepEqual(notes?.stops, [stop(20)]);
  assert.equal(problems.length, 2);
  assert.match(problems[0]!, /^stops\[1\]: /);
  assert.match(problems[1]!, /^stops\[2\]: /);
});

test("checkDebriefNotes drops a note on a missing line and passes boxes and scenarios through", () => {
  const far = { kind: "note", file: "server/b.ts", line: 6, text: "Too far." };
  const { notes, problems } = checkDebriefNotes({ ...valid, notes: [far] }, lines);
  assert.deepEqual(notes?.notes, []);
  assert.match(problems[0]!, /^notes\[0\]: /);
  assert.deepEqual(notes?.boxes, valid.boxes);
});
