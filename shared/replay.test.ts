import assert from "node:assert/strict";
import { test } from "node:test";
import { briefFor, type Memory, type Note } from "./memory";
import { ARMS, armBrief, fits, newFindingsLines, outcomeOf, pairKey, parseJudge, replayQueue, type CorpusRow } from "./replay";

function note(over: Partial<Note>): Note {
  return {
    slug: "n",
    type: "fact",
    steps: [],
    area: "server",
    files: [],
    citations: [],
    verified_at: null,
    last_used: null,
    status: "active",
    learned_in: [],
    supports: [],
    supersedes: [],
    superseded_by: [],
    globs: [],
    category: null,
    count: 0,
    evidence: [],
    extra: {},
    body: "",
    ...over,
  };
}

const area = note({ type: "area", slug: "server", area: null, globs: ["server/**"] });
const fact = note({ slug: "a-fact", body: "\nA fact.\n", files: ["server/a.ts"] });
const correction = note({ slug: "a-fix", type: "correction", category: "testing", count: 3, body: "\nA correction.\n" });
const memory: Memory = { areas: [area], notes: [fact, correction], backlinks: {}, summary: "", errors: [] };
const paths = ["server/x.ts"];

test("armBrief none is empty", () => {
  assert.deepEqual(armBrief(memory, "none", paths), []);
});

test("armBrief facts drops correction notes", () => {
  assert.deepEqual(armBrief(memory, "facts", paths), ["area server: server/**", "A fact. — server/a.ts"]);
});

test("armBrief facts+corrections is the full review brief", () => {
  const full = armBrief(memory, "facts+corrections", paths);
  assert.deepEqual(full, briefFor(memory, { step: "review", paths }));
  assert.equal(full.at(-1), "A correction. (×3)");
});

test("armBrief caps at 15 lines", () => {
  const many = Array.from({ length: 30 }, (_, i) => note({ slug: `f${i}`, body: `\nFact ${i}.\n` }));
  assert.equal(armBrief({ ...memory, notes: many }, "facts+corrections", paths).length, 15);
});

test("parseJudge reads matches and new findings", () => {
  assert.deepEqual(parseJudge('{"matches":[[0,1]],"new":[1]}', 2, 2), { matches: [[0, 1]], new: [1] });
});

test("parseJudge tolerates a fenced json block", () => {
  const reply = 'Here you go:\n```json\n{"matches":[[0,0]],"new":[]}\n```';
  assert.deepEqual(parseJudge(reply, 1, 1), { matches: [[0, 0]], new: [] });
});

test("parseJudge returns null for bad JSON, out-of-range indexes and wrong shapes", () => {
  assert.equal(parseJudge("not json", 1, 1), null);
  assert.equal(parseJudge('{"matches":[[2,0]],"new":[]}', 2, 1), null);
  assert.equal(parseJudge('{"matches":[[0,1]],"new":[]}', 2, 1), null);
  assert.equal(parseJudge('{"matches":[[0,0]],"new":[5]}', 2, 1), null);
  assert.equal(parseJudge('{"matches":[[-1,0]],"new":[]}', 2, 1), null);
  assert.equal(parseJudge('{"matches":[[0]],"new":[]}', 2, 1), null);
  assert.equal(parseJudge('{"matches":"x","new":[]}', 2, 1), null);
  assert.equal(parseJudge('{"matches":[]}', 2, 1), null);
  assert.equal(parseJudge("[]", 2, 1), null);
});

test("outcomeOf splits recorded into caught and not caught, and lists unmatched replay findings as new", () => {
  const out = outcomeOf(["r0", "r1", "r2"], ["p0", "p1", "p2"], [
    [0, 2],
    [2, 0],
  ]);
  assert.deepEqual(out, { caught: ["r0", "r2"], notCaught: ["r1"], new: ["p1"] });
});

test("outcomeOf is null when the judge gave no matches", () => {
  assert.equal(outcomeOf(["r0"], ["p0"], null), null);
});

test("newFindingsLines makes a yes/no checklist line per new finding", () => {
  const row = { story: "S8", round: 1, arm: "facts" as const, outcome: { caught: [], notCaught: [], new: ["Missing check", "Odd name"] } };
  assert.deepEqual(newFindingsLines(row), [
    "- [ ] yes / no — S8 r1 facts: Missing check",
    "- [ ] yes / no — S8 r1 facts: Odd name",
  ]);
  assert.deepEqual(newFindingsLines({ ...row, outcome: null }), []);
});

function row(story: string, round: number, kind: CorpusRow["kind"]): CorpusRow {
  return { initiative: "i", story, round, kind, commit: "c", base: "b", asOf: "2026-01-01T00:00:00Z", findings: [], plan: "", cycles: "" };
}
const label = (q: { row: CorpusRow }[]) => q.map((r) => `${r.row.story}${r.row.round}`);

test("replayQueue alternates failed and control rounds, failed first, with every arm", () => {
  const corpus = [row("a", 1, "failed"), row("b", 1, "failed"), row("c", 1, "control"), row("d", 1, "control")];
  const q = replayQueue(corpus, new Set());
  assert.deepEqual(label(q), ["a1", "c1", "b1", "d1"]);
  assert.deepEqual(q[0].arms, ARMS);
});

test("replayQueue carries on with the longer kind once the other runs out", () => {
  const corpus = [row("a", 1, "failed"), row("b", 1, "failed"), row("c", 1, "failed"), row("d", 1, "control")];
  assert.deepEqual(label(replayQueue(corpus, new Set())), ["a1", "d1", "b1", "c1"]);
});

test("replayQueue drops finished rounds and keeps only the missing arms of a partly done one", () => {
  const corpus = [row("a", 1, "failed"), row("c", 1, "control"), row("b", 1, "failed")];
  const done = new Set([...ARMS.map((arm) => pairKey(corpus[0], arm)), pairKey(corpus[1], "none")]);
  const q = replayQueue(corpus, done);
  assert.deepEqual(label(q), ["c1", "b1"]);
  assert.deepEqual(q[0].arms, ["facts", "facts+corrections"]);
  assert.deepEqual(q[1].arms, ARMS);
});

test("pairKey tells rounds and arms apart", () => {
  const a = row("a", 1, "failed");
  assert.notEqual(pairKey(a, "none"), pairKey(a, "facts"));
  assert.notEqual(pairKey(a, "none"), pairKey({ ...a, round: 2 }, "none"));
  assert.notEqual(pairKey(a, "none"), pairKey({ ...a, initiative: "j" }, "none"));
});

test("fits refuses a round that would overrun the cap", () => {
  assert.equal(fits(0, 1.2, 120, 3), true);
  assert.equal(fits(116.4, 1.2, 120, 3), true);
  assert.equal(fits(116.5, 1.2, 120, 3), false);
  assert.equal(fits(100, 1.2, 120, 0), true);
});
