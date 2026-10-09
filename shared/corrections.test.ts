import assert from "node:assert/strict";
import { test } from "node:test";
import {
  areaFor,
  type Classify,
  type Filing,
  fileObservations,
  mergeCorrections,
  MODEL,
  type Observation,
  observationsAsOf,
  PROMPT_VERSION,
  renderTopCorrections,
  reviewObservations,
  storyObservations,
} from "./corrections";
import { emptyNote, readAreaNames, renderSummary } from "./repo-facts";
import { appendOutcome } from "./story-outcome";

const base = "---\nid: S3\ntitle: Thing\nstatus: done\n---\n\n## Goal\n\nDo it.\n";
const text = [
  { kind: "review-failed" as const, round: 1, findings: ["server/x.ts:12 — wrong — fix"] },
  { kind: "fix" as const, attempt: 1, checks: ["lint", "unit tests"] },
  { kind: "blocked" as const, reason: "needs a key" },
].reduce(appendOutcome, base);
const ctx = { story: "S3", date: "2026-05-01", link: "https://example.test/pull/9" };

test("storyObservations turns review findings, failing checks and blocks into observations", () => {
  const obs = storyObservations(text, ctx);
  assert.deepEqual(
    obs.map((o) => [o.source, o.text]),
    [
      ["finding", "server/x.ts:12 — wrong — fix"],
      ["ci-check", "lint"],
      ["ci-check", "unit tests"],
      ["blocked", "needs a key"],
    ],
  );
  for (const o of obs) {
    assert.equal(o.story, "S3");
    assert.equal(o.date, "2026-05-01");
    assert.equal(o.link, ctx.link);
    assert.match(o.id, /^[0-9a-f]{12}$/);
  }
  assert.equal(new Set(obs.map((o) => o.id)).size, 4);
  assert.deepEqual(storyObservations(text, ctx).map((o) => o.id), obs.map((o) => o.id));
});

test("observationsAsOf drops later observations and the excluded story, and a date-only asOf covers the whole day", () => {
  const make = (id: string, story: string, date: string) => ({ id, source: "finding" as const, story, date, link: "", text: id });
  const obs = [
    make("a", "S1", "2026-04-30T10:00:00Z"),
    make("b", "S1", "2026-05-01T23:59:00Z"),
    make("c", "S1", "2026-05-02T00:00:00Z"),
    make("d", "S2", "2026-04-01"),
  ];
  const ids = (list: Observation[]) => list.map((o) => o.id);
  assert.deepEqual(ids(observationsAsOf(obs, { asOf: "2026-05-01" })), ["a", "b", "d"]);
  assert.deepEqual(ids(observationsAsOf(obs, { asOf: "2026-05-01T12:00:00Z", excludeStory: "S2" })), ["a"]);
  assert.deepEqual(ids(observationsAsOf(obs, { excludeStory: "S2" })), ["a", "b", "c"]);
  assert.deepEqual(ids(observationsAsOf(obs, {})), ["a", "b", "c", "d"]);
});

test("reviewObservations maps inline comments and review bodies, skips empty bodies, and ties a story by branch or pr-N", () => {
  const prs = [
    { number: 9, headRefName: "dm/thing" },
    { number: 10, headRefName: "dm/other" },
  ];
  const comments = {
    9: [
      { body: "Missing a test", path: "server/x.ts", line: 12, created_at: "2026-05-01T10:00:00Z", html_url: "https://example.test/c1" },
      { body: "  ", created_at: "2026-05-01T11:00:00Z", html_url: "https://example.test/c2" },
      { body: "Please narrow the type", submittedAt: "2026-05-01T12:00:00Z", url: "https://example.test/r1" },
    ],
    10: [{ body: "Handle the error", created_at: "2026-05-02T10:00:00Z", html_url: "https://example.test/c3" }],
  };
  const found = reviewObservations(prs, comments, { "dm/thing": "S3" });
  assert.equal(found.length, 3);
  assert.deepEqual(
    found.map(({ source, story, date, link, text }) => ({ source, story, date, link, text })),
    [
      { source: "review-comment", story: "S3", date: "2026-05-01T10:00:00Z", link: "https://example.test/c1", text: "server/x.ts:12 — Missing a test" },
      { source: "review-comment", story: "S3", date: "2026-05-01T12:00:00Z", link: "https://example.test/r1", text: "Please narrow the type" },
      { source: "review-comment", story: "pr-10", date: "2026-05-02T10:00:00Z", link: "https://example.test/c3", text: "Handle the error" },
    ],
  );
  assert.ok(found.every((o) => /^[0-9a-f]{12}$/.test(o.id)));
});

test("areaFor returns the area whose glob matches a path:line or a bare path in the text, else null", () => {
  const areas = [
    { id: "server", globs: ["server/**"] },
    { id: "shared-memory", globs: ["shared/memory.ts", "shared/notes/*.md"] },
  ];
  assert.equal(areaFor("server/x.ts:12 — Missing a test", areas), "server");
  assert.equal(areaFor("Please narrow the type in shared/memory.ts before merging", areas), "shared-memory");
  assert.equal(areaFor("see (shared/notes/a.md:3)", areas), "shared-memory");
  assert.equal(areaFor("Handle the error", areas), null);
  assert.equal(areaFor("docs/readme.md:1 — typo", areas), null);
});

test("fileObservations batches, reuses the cache, logs the cap first, stops at the cap and drops off-list categories", async () => {
  const make = (n: number): Observation => ({ id: `o${n}`, source: "finding", story: "S1", date: "2026-05-01", link: "", text: `note ${n}` });
  const obs = [0, 1, 2, 3, 4].map(make);
  const areas = [{ id: "server", globs: ["server/**"] }];
  const calls: string[][] = [];
  const classify: Classify = async (batch) => {
    calls.push(batch.map((o) => o.id));
    return { filings: batch.map((o) => ({ id: o.id, category: "testing", area: "server", phrase: "add a test" })), costUsd: 0.01 };
  };
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);

  const first = await fileObservations(obs, { cache: {}, classify, costCap: 3, areas, log, batchSize: 2 });
  assert.deepEqual(calls, [["o0", "o1"], ["o2", "o3"], ["o4"]]);
  assert.equal(logs[0], "cost cap $3.00");
  assert.equal(first.stopped, null);
  assert.equal(first.filed.length, 5);
  assert.ok(Math.abs(first.spentUsd - 0.03) < 1e-9);
  assert.ok(first.cache[`${PROMPT_VERSION}:${MODEL}:o0`]);

  // cached ids are not re-sent
  calls.length = 0;
  const second = await fileObservations([...obs, make(5)], { cache: first.cache, classify, costCap: 3, areas, log, batchSize: 2 });
  assert.deepEqual(calls, [["o5"]]);
  assert.equal(second.filed.length, 6);

  // a cap that fits one batch files one batch and stops
  calls.length = 0;
  const capped = await fileObservations(obs, { cache: {}, classify, costCap: 0.02, areas, log, batchSize: 2 });
  assert.deepEqual(calls, [["o0", "o1"]]);
  assert.equal(capped.stopped, "cap");
  assert.deepEqual(capped.filed.map((f: Filing) => f.id), ["o0", "o1"]);

  // an off-list category is dropped and logged
  logs.length = 0;
  const odd: Classify = async (batch) => ({
    filings: batch.map((o) => ({ id: o.id, category: o.id === "o0" ? "vibes" : "types", area: null, phrase: "narrow it" })),
    costUsd: 0,
  });
  const dropped = await fileObservations(obs.slice(0, 2), { cache: {}, classify: odd, costCap: 3, areas, log });
  assert.deepEqual(dropped.filed.map((f: Filing) => f.id), ["o1"]);
  assert.ok(logs.some((line) => line.includes("o0") && line.includes("vibes")));
});

test("fileObservations takes the area from code first, the model's area only if known, and stops on a classify error", async () => {
  const areas = [{ id: "server", globs: ["server/**"] }, { id: "shared", globs: ["shared/**"] }];
  const o = (id: string, text: string): Observation => ({ id, source: "finding", story: "S1", date: "", link: "", text });
  const obs = [o("a", "server/x.ts:1 — bad"), o("b", "vague"), o("c", "vague too")];
  const classify: Classify = async (batch) => ({
    filings: batch.map((x) => ({ id: x.id, category: "types", area: x.id === "c" ? "nowhere" : "shared", phrase: "p" })),
    costUsd: 0,
  });
  const result = await fileObservations(obs, { cache: {}, classify, costCap: 3, areas, log: () => {} });
  assert.deepEqual(result.filed.map((f: Filing) => [f.id, f.area]), [["a", "server"], ["b", "shared"], ["c", null]]);

  const logs: string[] = [];
  let n = 0;
  const flaky: Classify = async (batch) => {
    if (++n === 2) throw new Error("boom");
    return { filings: batch.map((x) => ({ id: x.id, category: "types", area: null, phrase: "p" })), costUsd: 0 };
  };
  const failed = await fileObservations(obs, { cache: {}, classify: flaky, costCap: 3, areas, log: (l) => logs.push(l), batchSize: 2 });
  assert.equal(failed.stopped, "error");
  assert.deepEqual(failed.filed.map((f: Filing) => f.id), ["a", "b"]);
  assert.ok(logs.some((l) => l.includes("boom")));
});

test("mergeCorrections makes one seeded note per category, area and normalised phrase, with count, links, stories and newest date", () => {
  const o = (id: string, story: string, date: string, text: string): Observation => ({
    id, source: "finding", story, date, link: `https://example.test/${id}`, text,
  });
  const obs = [
    o("a", "S1", "2026-05-01T10:00:00Z", "server/x.ts:12 — no test"),
    o("b", "S2", "2026-05-03T10:00:00Z", "server/y.ts — still no test"),
    o("c", "S2", "2026-05-02", "again, see server/x.ts"),
    o("d", "S4", "2026-05-04", "other"),
    o("e", "S5", "2026-05-05", "other too"),
    o("f", "S6", "2026-05-06", "other three"),
  ];
  const obsById = new Map(obs.map((x) => [x.id, x]));
  const filed: Filing[] = [
    { id: "a", category: "testing", area: "server", phrase: "Add a  test " },
    { id: "b", category: "testing", area: "server", phrase: "add a test" },
    { id: "c", category: "testing", area: "server", phrase: "ADD A TEST" },
    { id: "d", category: "testing", area: "shared", phrase: "add a test" },
    { id: "e", category: "types", area: "server", phrase: "add a test" },
    { id: "f", category: "types", area: "server", phrase: "one two three four five six seven" },
  ];
  const notes = mergeCorrections(filed, obsById);
  assert.deepEqual(notes.map((n) => [n.category, n.area, n.slug, n.count]), [
    ["testing", "server", "add-a-test", 3],
    ["types", "server", "add-a-test", 1],
    ["testing", "shared", "add-a-test-2", 1],
    ["types", "server", "one-two-three-four-five-six", 1],
  ]);
  const top = notes[0];
  assert.equal(top.type, "correction");
  assert.equal(top.status, "seeded");
  assert.deepEqual(top.steps, []);
  assert.deepEqual(top.evidence, ["https://example.test/a", "https://example.test/b", "https://example.test/c"]);
  assert.deepEqual(top.learned_in, ["S1", "S2"]);
  assert.equal(top.verified_at, "2026-05-03");
  assert.deepEqual(top.files, ["server/x.ts", "server/y.ts"]);
  assert.equal(top.body, "add a test\n\nserver/x.ts:12 — no test\nserver/y.ts — still no test\nagain, see server/x.ts");
  assert.deepEqual(mergeCorrections(filed, obsById), notes);
});

test("renderTopCorrections lists at most 10 corrections by count then id and keeps SUMMARY.md readable", () => {
  const notes = Array.from({ length: 12 }, (_, i) => {
    const note = emptyNote(`fix-${String(i).padStart(2, "0")}`, "correction", "2026-05-01");
    note.category = i === 5 ? "style" : "ci-env";
    note.area = i === 5 ? null : "server";
    note.count = i < 2 ? 5 : 1;
    note.body = i === 5 ? "use a | pipe\nsecond line" : `phrase ${i}`;
    return note;
  });
  const section = renderTopCorrections([...notes].reverse());
  const rows = section.split("\n").filter((line) => /^\| \d+ \|/.test(line));
  assert.ok(section.startsWith("## Top corrections\n"));
  assert.equal(rows.length, 10);
  assert.match(section, /\| count \| category \| area \| correction \| id \|/);
  assert.deepEqual(rows.slice(0, 3).map((r) => r.split("|")[1].trim()), ["5", "5", "1"]);
  assert.match(rows[0], /corrections\/ci-env\/fix-00 \|$/);
  assert.match(rows[1], /\| server \|/);
  assert.ok(!section.includes("fix-11"));
  assert.equal(renderTopCorrections([notes[5]]).split("\n").filter((l) => l.includes("pipe"))[0].includes("use a \\| pipe"), true);
  assert.match(renderTopCorrections([]), /^## Top corrections\n\nNone yet\.\n?$/);

  const areas = [emptyNote("server", "area", "2026-05-01")];
  const summary = `${renderSummary(areas, { server: 1 }, new Map([["server", "backend"]]))}\n${section}`;
  assert.deepEqual([...readAreaNames(summary)], [["server", "backend"]]);
});
