// render(data) on a small fixture: four sections, coverage line, every merged story listed, deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { render, outcomeUpdates, snapshotStories } from "./report.mjs";

const data = {
  cutoff: "2026-10-09T14:01:28Z",
  stories: [
    { initiative: "z-init", id: "S1", title: "Zed story", hasAgents: false, reviewRounds: 1, fixAttempts: 0 },
    { initiative: "a-init", id: "S2", title: "Alpha story", hasAgents: true, reviewRounds: 3, fixAttempts: 2 },
  ],
  agents: [
    { step: "implement", hasTranscript: true, reads: 4, searches: 2, files: 3, chars: 1000, edited: true, shellCalls: 6, shellChars: 500 },
    { step: "implement", hasTranscript: true, reads: 2, searches: 0, files: 2, chars: 200, edited: false, shellCalls: 2, shellChars: 100 },
    { step: "plan", hasTranscript: true, reads: 1, searches: 1, files: 1, chars: 40, edited: true, shellCalls: 0, shellChars: 0 },
    { step: "plan", hasTranscript: false },
  ],
  repeat: [
    { area: "shared", category: "testing", findings: 4, repeats: 3 },
    { area: "server", category: "types", findings: 2, repeats: 0 },
  ],
  ratios: [1, 2, 3, 4, 5],
};

test("render: sections, coverage, stories, calibration", () => {
  const out = render(data);
  for (const h of ["## Exploration per step", "## Review rounds and fix attempts per story", "## Repeat rate", "## Calibration"]) {
    assert.ok(out.includes(h), h);
  }
  assert.match(out, /Shell calls before first edit/);
  assert.match(out, /keyword guess/);
  // implement: 2 agents, mean reads 3, 1 of 2 reached an edit (50%), shell calls 8
  assert.match(out, /\| implement \| 2 \| 6 \| 2 \| 5 \| 1,200 \| 50% \| 8 \|/);
  // median 3, quartiles 2 and 4 (IQR 2), n 5
  assert.match(out, /median ratio 3\.00, IQR 2\.00 \(2\.00 to 4\.00\), n = 5/);
  assert.match(out, /Stories: 1 with agent records, 1 without/);
  assert.match(out, /Agents: 3 with transcripts, 1 without/);
  assert.ok(out.includes("Alpha story") && out.includes("Zed story"));
  assert.ok(out.indexOf("Alpha story") < out.indexOf("Zed story"), "sorted by initiative, then id");
  assert.match(out, /\| shared \| testing \| 4 \| 3 \| 75% \|/);
  assert.equal(render(data), render(structuredClone(data)));
  assert.ok(!/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/.test(out.replace(data.cutoff, "")), "no other timestamps");
});

test("render: empty calibration does not divide by zero", () => {
  assert.match(render({ ...data, ratios: [] }), /n = 0/);
});

test("outcomeUpdates: only story files without ## Outcome", () => {
  const events = [{ kind: "merged" }];
  const todo = outcomeUpdates("---\nid: S1\n---\n\n## Goal\nx\n", events);
  assert.ok(todo && todo.includes("## Outcome"));
  assert.equal(outcomeUpdates(todo, events), null);
});

const story = (initiative, id, fm = {}) => ({ initiative, fm: { id, ...fm } });
const CUT = "2026-10-09T14:00:00Z";

test("snapshotStories: keeps only stories whose PR merged by the cutoff", () => {
  const prs = [
    { number: 1, headRefName: "b/early", mergedAt: "2026-10-09T10:00:00Z" },
    { number: 2, headRefName: "b/late", mergedAt: "2026-10-09T15:00:00Z" },
  ];
  const out = snapshotStories([story("i", "S1", { branch: "b/early" }), story("i", "S2", { branch: "b/late" }), story("i", "S3", { branch: "b/none" }), story("i", "S4", {})], prs, CUT);
  assert.deepEqual(out.map((f) => f.fm.id), ["S1"]);
  assert.equal(out[0].pr.number, 1);
});

test("snapshotStories: a PR merged exactly at the cutoff is kept", () => {
  const prs = [{ number: 1, headRefName: "b/edge", mergedAt: CUT }];
  assert.deepEqual(snapshotStories([story("i", "S1", { branch: "b/edge" })], prs, CUT).map((f) => f.fm.id), ["S1"]);
});

test("snapshotStories: PR number match beats branch match", () => {
  const prs = [
    { number: 1, headRefName: "b/x", mergedAt: "2026-10-09T10:00:00Z" },
    { number: 2, headRefName: "b/y", mergedAt: "2026-10-09T11:00:00Z" },
  ];
  const [f] = snapshotStories([story("i", "S1", { pr: "2", branch: "b/x" })], prs, CUT);
  assert.equal(f.pr.number, 2);
});

test("snapshotStories: ordered by mergedAt, then initiative, then id", () => {
  const prs = [
    { number: 1, headRefName: "a", mergedAt: "2026-10-09T12:00:00Z" },
    { number: 2, headRefName: "b", mergedAt: "2026-10-09T12:00:00Z" },
    { number: 3, headRefName: "c", mergedAt: "2026-10-09T12:00:00Z" },
    { number: 4, headRefName: "d", mergedAt: "2026-10-09T09:00:00Z" },
  ];
  const out = snapshotStories([story("z", "S1", { branch: "a" }), story("a", "S2", { branch: "b" }), story("a", "S1", { branch: "c" }), story("z", "S9", { branch: "d" })], prs, CUT);
  assert.deepEqual(out.map((f) => `${f.initiative}/${f.fm.id}`), ["z/S9", "a/S1", "a/S2", "z/S1"]);
});

const ids = (out) => out.map((f) => f.fm.id);

test("snapshotStories: a no-PR story is kept or dropped by its merged_at", () => {
  const out = snapshotStories([story("i", "S1", { merged_at: "2026-10-09T10:00:00.000Z" }), story("i", "S2", { merged_at: "2026-10-09T15:00:00.000Z" })], [], CUT);
  assert.deepEqual(ids(out), ["S1"]);
  assert.equal(out[0].pr, undefined);
});

test("snapshotStories: merged_at wins over the PR date in both directions", () => {
  const prs = [
    { number: 1, headRefName: "late", mergedAt: "2026-10-09T15:00:00Z" },
    { number: 2, headRefName: "early", mergedAt: "2026-10-09T10:00:00Z" },
  ];
  const out = snapshotStories([
    story("i", "S1", { branch: "late", merged_at: "2026-10-09T09:00:00.000Z" }),
    story("i", "S2", { branch: "early", merged_at: "2026-10-09T16:00:00.000Z" }),
  ], prs, CUT);
  assert.deepEqual(ids(out), ["S1"]);
  assert.equal(out[0].pr.number, 1);
});

test("snapshotStories: a merged_at inside the cutoff second but after it is dropped", () => {
  assert.deepEqual(ids(snapshotStories([story("i", "S1", { merged_at: "2026-10-09T14:00:00.300Z" })], [], CUT)), []);
});

test("snapshotStories: a story with neither date is dropped", () => {
  assert.deepEqual(ids(snapshotStories([story("i", "S1", { branch: "nope" })], [], CUT)), []);
});

test("snapshotStories: an unparseable merged_at falls back to the PR date", () => {
  const prs = [{ number: 1, headRefName: "a", mergedAt: "2026-10-09T10:00:00Z" }];
  assert.deepEqual(ids(snapshotStories([story("i", "S1", { branch: "a", merged_at: "garbage" }), story("i", "S2", { merged_at: "garbage" })], prs, CUT)), ["S1"]);
});

test("snapshotStories: ordered by close date across PR-dated and merged_at-dated stories", () => {
  const prs = [{ number: 1, headRefName: "a", mergedAt: "2026-10-09T11:00:00Z" }];
  const out = snapshotStories([story("i", "S1", { branch: "a" }), story("i", "S2", { merged_at: "2026-10-09T10:00:00.500Z" }), story("i", "S3", { merged_at: "2026-10-09T12:00:00.000Z" })], prs, CUT);
  assert.deepEqual(ids(out), ["S2", "S1", "S3"]);
});

test("render: stories intro describes the merged_at dating rule", () => {
  const text = render(data);
  assert.match(text, /dated by its `merged_at`/);
  assert.match(text, /neither are left out/);
  assert.doesNotMatch(text, /closed without a PR are left out/);
});

test("snapshotStories: a merged_at without an ISO date and zone is treated as absent", () => {
  const out = snapshotStories([story("i", "S1", { merged_at: "1" }), story("i", "S2", { merged_at: "2026-10-09T05:00:00" }), story("i", "S3", { merged_at: "2026-10-09T15:00:00+02:00" })], [], CUT);
  assert.deepEqual(ids(out), ["S3"]);
});
