import assert from "node:assert/strict";
import { test } from "node:test";
import { checkMotion, MOTION_PROMPT, NO_DECISION, renderMotion, sceneTimes, type Motion, type MotionScene } from "./motion-brief";
import type { DiffFile } from "./motion-diff";

const file = (path: string, status: DiffFile["status"], added: string[], removed: string[] = []): DiffFile => ({
  path, status, added, removed, addedNames: [], removedNames: [], addedTests: [], text: "",
});
const files = [
  file("client/strip.tsx", "M", ["  style={{ zIndex: 1000 }}", "const chain = filter(isLive).map(toRow);"], ["  <Overlay  portal />"]),
  file("client/old-overlay.tsx", "D", [], ["export function Overlay() {}"]),
];

const scene = (n: number, extra: Partial<MotionScene> = {}): MotionScene => ({
  name: `Scene ${n}`,
  visual: 'A strip slides to the top, tagged "z 1000".',
  labels: [{ text: "z 1000", code: ["zIndex: 1000"] }],
  beats: [{ caption: "The strip sits above every panel." }],
  decision: { text: "Raise the strip with a z-index.", refs: [{ file: "client/strip.tsx", side: "+", snippet: "zIndex:   1000" }] },
  instead_of: { text: "A portal overlay.", refs: [{ file: "client/strip.tsx", side: "-", snippet: "<Overlay portal />" }] },
  because: null,
  ...extra,
});
const motion = (scenes: MotionScene[]): Motion => ({ title: "Strip on top", subtitle: "One z-index", metaphor: "a stack of glass cards", scenes });
const six = () => [1, 2, 3, 4, 5].map((n) => scene(n)).concat(scene(6, { name: "Collapse" }));

test("MOTION_PROMPT tells the writer the shape and forbids unshown alternatives and motives", () => {
  for (const phrase of ["instead_of", "null", "no rejected alternative", "no motive", '"side"', "6 to 8 scenes", "20 words", "Collapse", "Every piece of text in double quotes"]) {
    assert.ok(MOTION_PROMPT.includes(phrase), phrase);
  }
});

test("checkMotion keeps a valid brief whole, matching snippets after squeezing whitespace", () => {
  const { motion: checked, problems } = checkMotion(motion(six()), files);
  assert.deepEqual(problems, []);
  assert.deepEqual(checked, motion(six()));
});

test("a top-level schema failure is one problem and no brief", () => {
  const { motion: checked, problems } = checkMotion({ title: "x" }, files);
  assert.equal(checked, null);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /^motion\.json: /);
});

test("a decision with no ref to an added line, or a snippet not in the diff, drops the scene", () => {
  const removedOnly = scene(1, { decision: { text: "x", refs: [{ file: "client/strip.tsx", side: "-", snippet: "Overlay" }] } });
  const made = scene(2, { decision: { text: "x", refs: [{ file: "client/strip.tsx", side: "+", snippet: "zIndex: 9999" }] } });
  const { motion: checked, problems } = checkMotion(motion([removedOnly, made, ...six()]), files);
  assert.deepEqual(checked?.scenes.map((s) => s.name), six().map((s) => s.name));
  assert.equal(problems.length, 2);
  assert.match(problems[0]!, /^scenes\[0\] \(Scene 1\): decision/);
  assert.match(problems[1]!, /^scenes\[1\] \(Scene 2\): decision/);
});

test("instead_of must cite removed lines or a deleted file, else it becomes null and the scene stays", () => {
  const deleted = { text: "The old overlay.", refs: [{ file: "client/old-overlay.tsx", side: "-" as const, snippet: "anything" }] };
  const added = { text: "Invented.", refs: [{ file: "client/strip.tsx", side: "+" as const, snippet: "zIndex: 1000" }] };
  const scenes = six();
  scenes[0] = scene(1, { instead_of: deleted });
  scenes[1] = scene(2, { instead_of: added });
  const { motion: checked, problems } = checkMotion(motion(scenes), files);
  assert.deepEqual(checked?.scenes[0]!.instead_of, deleted);
  assert.equal(checked?.scenes[1]!.instead_of, null);
  assert.deepEqual(problems.length, 1);
  assert.match(problems[0]!, /^scenes\[1\] \(Scene 2\): instead_of/);
});

test("because needs an added line, else it becomes null and the scene stays", () => {
  const scenes = six();
  scenes[2] = scene(3, { because: { text: "Faster.", refs: [] } });
  const { motion: checked, problems } = checkMotion(motion(scenes), files);
  assert.equal(checked?.scenes[2]!.because, null);
  assert.match(problems[0]!, /^scenes\[2\] \(Scene 3\): because/);
});

test("a quoted label not in labels, or label code not on a +/- line, drops the scene", () => {
  const scenes = six();
  scenes[0] = scene(1, { visual: 'Show "z 9000".' });
  scenes[1] = scene(2, { labels: [{ text: "z 1000", code: ["zIndex: 2000"] }] });
  scenes[2] = scene(3, { visual: "Show “filter chain”.", labels: [{ text: "filter chain", code: ["filter(isLive).map(toRow)"] }] });
  const { motion: checked, problems } = checkMotion(motion(scenes), files);
  assert.deepEqual(checked?.scenes.map((s) => s.name), ["Scene 3", "Scene 4", "Scene 5", "Collapse"]);
  assert.match(problems[0]!, /^scenes\[0\] \(Scene 1\): label "z 9000"/);
  assert.match(problems[1]!, /^scenes\[1\] \(Scene 2\): label "z 1000"/);
  assert.match(problems.at(-1)!, /^scenes: 4 passed/);
});

test("a caption over 20 words or 2 sentences keeps the scene and its caption, with a warning line", () => {
  const dropped = scene(0, { decision: { text: "x", refs: [] } });
  const scenes = six();
  scenes[1] = scene(2, { beats: [{ caption: Array(24).fill("word").join(" ") }] });
  scenes[2] = scene(3, { beats: [{ caption: "One." }, { caption: "Two. Three. Four." }] });
  const { motion: checked, problems } = checkMotion(motion([dropped, ...scenes]), files);
  assert.deepEqual(checked?.scenes, scenes, "every scene and caption kept as written");
  assert.deepEqual(problems.slice(1), [
    "Scene 2 caption is 24 words (limit 20)",
    "Scene 3 beat two caption is 3 sentences (limit 2)",
  ]);
});

test("more than 8 scenes keeps the first 8; a last scene not Collapse or finished is a problem line", () => {
  const nine = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => scene(n));
  const { motion: checked, problems } = checkMotion(motion(nine), files);
  assert.equal(checked?.scenes.length, 8);
  assert.deepEqual(problems, ["scenes: 9 given, kept the first 8", 'scenes: the last scene should be "Collapse" or show the finished result']);
  const finished = [...six().slice(0, 5), scene(6, { name: "The finished strip" })];
  assert.deepEqual(checkMotion(motion(finished), files).problems, []);
});

test("fewer than 2 passing scenes is no brief and the no-decision problem", () => {
  const bad = { text: "x", refs: [] };
  const { motion: checked, problems } = checkMotion(motion([scene(1), scene(2, { decision: bad })]), files);
  assert.equal(checked, null);
  assert.equal(problems.at(-1), NO_DECISION);
});

test("sceneTimes gives the first scene 8s and splits the rest by beats, in whole seconds ending on the total", () => {
  assert.deepEqual(sceneTimes([1, 1, 1, 1, 1, 1], 65), [[0, 8], [8, 19], [19, 31], [31, 42], [42, 54], [54, 65]]);
  assert.deepEqual(sceneTimes([2, 2, 1], 65), [[0, 8], [8, 46], [46, 65]]);
});

test("renderMotion writes the header, the timed scenes and their captions", () => {
  const two = scene(2, { name: "Split", beats: [{ caption: "First." }, { caption: "Second." }] });
  const text = renderMotion(motion([scene(1, { name: "Start" }), two, scene(3, { name: "Collapse" })]));
  assert.equal(
    text,
    [
      'Make a 65-second animated explainer in 3 scenes, dark UI, clean technical style. Title: **"Strip on top"** Subtitle: "One z-index" Show a stack of glass cards. Use captions, no voiceover.',
      "",
      '**Scene 1 (0–8s): Start.** A strip slides to the top, tagged "z 1000". Caption: "The strip sits above every panel."',
      "",
      '**Scene 2 (8–46s): Split.** A strip slides to the top, tagged "z 1000". Beat one caption: "First." Beat two caption: "Second."',
      "",
      '**Scene 3 (46–65s): Collapse.** A strip slides to the top, tagged "z 1000". Caption: "The strip sits above every panel."',
      "",
    ].join("\n"),
  );
});
