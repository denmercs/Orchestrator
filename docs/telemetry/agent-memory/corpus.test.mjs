// Corpus rows: one per Review round to replay. Failed rounds first, then as many first-pass controls, most recent first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corpusRows, main, storyBody } from "./corpus.mjs";

const review = (initiative, story, round, createdAt) => ({ initiative, story, step: "review", round, createdAt });
const commit = (oid, committedDate, parent, parentDate) => ({ oid, committedDate, parent, parentDate });
const key = (story) => `init/${story}`;

const stories = [
  { initiative: "init", id: "S1", title: "First story", body: "## Goal\nDo it." },
  { initiative: "init", id: "S2" },
  { initiative: "init", id: "S3" },
  { initiative: "init", id: "S4" },
];
const agents = [
  review("init", "S1", 1, "2026-10-01T10:00:00Z"),
  review("init", "S1", 2, "2026-10-01T12:00:00Z"),
  review("init", "S2", 1, "2026-10-02T10:00:00Z"),
  review("init", "S3", 1, "2026-10-03T10:00:00Z"),
  review("init", "S4", 1, "2026-10-04T10:00:00Z"),
  { initiative: "init", story: "S1", step: "implement", round: null, createdAt: "2026-10-01T08:00:00Z" },
];
const prCommits = {
  [key("S1")]: [
    commit("a1", "2026-10-01T08:30:00Z", "base1", "2026-09-30T17:00:00Z"),
    commit("a2", "2026-10-01T09:30:00Z"),
    commit("a3", "2026-10-01T11:00:00Z"),
  ],
  [key("S2")]: [commit("b1", "2026-10-02T08:00:00Z", "base2", "2026-10-01T20:00:00Z"), commit("b2", "2026-10-02T09:00:00Z")],
  [key("S3")]: [commit("c1", "2026-10-03T08:00:00Z", "base3", "2026-10-02T20:00:00Z")],
  [key("S4")]: [commit("d1", "2026-10-04T08:00:00Z", "base4", "2026-10-03T20:00:00Z")],
};
const findingsByRound = { [key("S1")]: { 1: ["server/a.ts:1 — missing test"] } };
const plans = { [key("S1")]: { plan: "the plan", cycles: "- [x] Cycle 1" } };

test("a failed row for the round-1-failed story: commit before the Review, base, asOf, findings, plan", () => {
  const rows = corpusRows({ stories, agents, prCommits, findingsByRound, plans, controls: 0 });
  assert.deepEqual(rows, [
    {
      initiative: "init",
      story: "S1",
      title: "First story",
      body: "## Goal\nDo it.",
      round: 1,
      kind: "failed",
      commit: "a2",
      base: "base1",
      asOf: "2026-09-30T17:00:00Z",
      findings: ["server/a.ts:1 — missing test"],
      plan: "the plan",
      cycles: "- [x] Cycle 1",
    },
  ]);
});

test("controls are first-pass Reviews, most recent first, as many as failed rounds by default", () => {
  const rows = corpusRows({ stories, agents, prCommits, findingsByRound, plans });
  assert.deepEqual(rows.map((r) => [r.story, r.round, r.kind]), [["S1", 1, "failed"], ["S4", 1, "control"]]);
  const control = rows[1];
  assert.equal(control.commit, "d1");
  assert.equal(control.base, "base4");
  assert.deepEqual(control.findings, []);
  assert.equal(control.plan, "");
  assert.equal(control.cycles, "");
});

test("a controls option overrides the count", () => {
  const rows = corpusRows({ stories, agents, prCommits, findingsByRound, plans, controls: 5 });
  assert.deepEqual(rows.filter((r) => r.kind === "control").map((r) => r.story), ["S4", "S3", "S2"]);
});

test("a story with no PR commits is skipped", () => {
  const rows = corpusRows({ stories, agents, prCommits: { ...prCommits, [key("S1")]: [] }, findingsByRound, plans, controls: 0 });
  assert.deepEqual(rows, []);
});

test("asOf is the base's date, not the first PR commit's", () => {
  const [row] = corpusRows({ stories, agents, prCommits, findingsByRound, plans, controls: 0 });
  assert.equal(row.asOf, "2026-09-30T17:00:00Z");
});

test("a story without a title falls back to its id and an empty body", () => {
  const rows = corpusRows({ stories, agents, prCommits, findingsByRound, plans, controls: 1 });
  assert.equal(rows[1].title, "S4");
  assert.equal(rows[1].body, "");
});

test("storyBody drops frontmatter and ## Outcome but keeps the other sections", () => {
  const text = "---\nid: S1\ntitle: T\n---\n\n## Goal\nDo it.\n\n## Acceptance\n- done\n\n## Outcome\n\n### Review round 1\n- leaked finding\n";
  assert.equal(storyBody(text), "## Goal\nDo it.\n\n## Acceptance\n- done");
  const mid = "---\nid: S1\n---\n## Outcome\n- leaked\n\n## Notes\n- kept\n";
  assert.equal(storyBody(mid), "## Notes\n- kept");
});

// main(argv, deps): the CLI, with agents, gh and git faked.
const fakeRepo = () => {
  const root = mkdtempSync(join(tmpdir(), "corpus-root-"));
  mkdirSync(join(root, ".harness", "initiatives"), { recursive: true });
  return root;
};
const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
};
const fakes = (extra = {}) => {
  const calls = { agents: [], run: [] };
  return {
    calls,
    deps: {
      loopAgents: (opts) => (calls.agents.push(opts), []),
      run: (cmd, args, opts) => (calls.run.push({ cmd, cwd: opts?.cwd }), "[]"),
      exit: (code) => { throw new Error(`exit ${code}`); },
      ...extra,
    },
  };
};

test("main asks loopAgents for every agent: until is past now", () => {
  const repo = fakeRepo();
  const { calls, deps } = fakes({ repo });
  quiet(() => main(["node", "corpus.mjs"], deps));
  assert.equal(calls.agents.length, 1);
  assert.equal(calls.agents[0].repo, repo);
  assert.ok(calls.agents[0].until > new Date().toISOString());
});

test("--root makes the story files, gh cwd and output path use that directory", () => {
  const root = fakeRepo();
  const { calls, deps } = fakes();
  quiet(() => main(["node", "corpus.mjs", "--root", root], deps));
  assert.equal(calls.agents[0].repo, root);
  assert.ok(calls.run.length > 0 && calls.run.every((c) => c.cwd === root));
  assert.ok(existsSync(join(root, ".harness", "replay", "corpus.jsonl")));
});

test("--cap writes the cost-cap file next to corpus.jsonl", () => {
  const root = fakeRepo();
  quiet(() => main(["node", "corpus.mjs", "--root", root, "--cap", "50"], fakes().deps));
  assert.equal(readFileSync(join(root, ".harness", "replay", "cost-cap"), "utf8").trim(), "50");
});

test("a bad --cap exits 1 and writes nothing", () => {
  const root = fakeRepo();
  const errors = console.error;
  console.error = () => {};
  try {
    assert.throws(() => main(["node", "corpus.mjs", "--root", root, "--cap", "lots"], fakes().deps), /exit 1/);
  } finally { console.error = errors; }
  assert.ok(!existsSync(join(root, ".harness", "replay")));
});

test("a commit made in the same second as the Review (gh drops the milliseconds) still counts as before it", () => {
  const rows = corpusRows({
    stories: [{ initiative: "init", id: "S1" }],
    agents: [review("init", "S1", 1, "2026-10-10T01:40:12.903Z"), review("init", "S1", 2, "2026-10-10T01:47:03.244Z")],
    prCommits: { [key("S1")]: [commit("a1", "2026-10-10T01:40:12Z", "base", "2026-10-09T20:00:00Z"), commit("a2", "2026-10-10T01:47:03Z")] },
    controls: 0,
  });
  assert.deepEqual(rows.map((r) => [r.kind, r.round, r.commit]), [["failed", 1, "a1"]]);
});
