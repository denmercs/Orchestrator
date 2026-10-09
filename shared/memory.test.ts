import assert from "node:assert/strict";
import { test } from "node:test";
import { citationHash, formatCitation, parseCitation } from "./memory";

test("citations round-trip path:from-to#hash", () => {
  const text = "server/a.ts:10-14#1a2b3c4d";
  const citation = parseCitation(text);
  assert.deepEqual(citation, { path: "server/a.ts", from: 10, to: 14, hash: "1a2b3c4d" });
  assert.equal(formatCitation(citation), text);
});

test("parseCitation rejects a missing hash or a bad range", () => {
  assert.throws(() => parseCitation("server/a.ts:10-14"), /citation/);
  assert.throws(() => parseCitation("server/a.ts:14-10#1a2b3c4d"), /citation/);
  assert.throws(() => parseCitation("server/a.ts:0-3#1a2b3c4d"), /citation/);
});

test("citationHash trims each line and gives 8 hex chars", () => {
  const hash = citationHash(["  const a = 1;", "return a;  "]);
  assert.match(hash, /^[0-9a-f]{8}$/);
  assert.equal(hash, citationHash(["const a = 1;", "return a;"]));
  assert.notEqual(hash, citationHash(["const a = 2;", "return a;"]));
});

import { CORRECTION_CATEGORIES, formatNote, parseNote, type Note } from "./memory";

function note(over: Partial<Note> = {}): Note {
  return {
    slug: "no-provider-branches",
    type: "decision",
    steps: [],
    area: null,
    files: [],
    citations: [],
    verified_at: null,
    last_used: null,
    status: "seeded",
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

const FACT = `---
type: fact
steps:
  - plan
  - implement
area: server-harness
files:
  - server/harness-layout.ts
citations:
  - server/harness-layout.ts:10-14#1a2b3c4d
verified_at: 2026-10-01
last_used:
status: active
learned_in:
  - S3
supports:
  - decisions/no-provider-branches
supersedes: []
superseded_by: []
approved: yes
reviewers:
  - dm
---

Frontmatter reads flat key: value only.
`;

test("a fact round-trips through parseNote and formatNote", () => {
  const parsed = parseNote(FACT, "flat-frontmatter");
  assert.equal(parsed.slug, "flat-frontmatter");
  assert.equal(parsed.type, "fact");
  assert.deepEqual(parsed.steps, ["plan", "implement"]);
  assert.equal(parsed.area, "server-harness");
  assert.deepEqual(parsed.citations, [{ path: "server/harness-layout.ts", from: 10, to: 14, hash: "1a2b3c4d" }]);
  assert.equal(parsed.last_used, null);
  assert.deepEqual(parsed.supersedes, []);
  assert.deepEqual(parsed.extra, { approved: "yes", reviewers: ["dm"] });
  assert.equal(parsed.body, "\nFrontmatter reads flat key: value only.\n");
  assert.equal(formatNote(parsed), FACT);
});

test("a decision with empty lists and null scalars round-trips from a note", () => {
  const n = note({ body: "\nNo branching on provider.\n", extra: { approved: "" } });
  const text = formatNote(n);
  assert.match(text, /^---\ntype: decision\nsteps: \[\]\narea:\n/);
  assert.deepEqual(parseNote(text, n.slug), n);
});

test("parseNote throws without frontmatter", () => {
  assert.throws(() => parseNote("no frontmatter", "x"), /x/);
});

const AREA = `---
type: area
steps: []
area:
files: []
citations: []
verified_at:
last_used:
status: seeded
learned_in: []
supports: []
supersedes: []
superseded_by: []
globs:
  - server/**
  - shared/*.ts
---

Server-side harness code.
`;

const CORRECTION = `---
type: correction
steps:
  - implement
area: server-harness
files: []
citations: []
verified_at:
last_used: 2026-10-02
status: active
learned_in:
  - S2
supports: []
supersedes: []
superseded_by: []
category: testing
count: 3
evidence:
  - S2
  - corrections/testing/other
---

Write the failing test first.
`;

test("an area keeps its globs and writes no category fields", () => {
  const parsed = parseNote(AREA, "server-harness");
  assert.deepEqual(parsed.globs, ["server/**", "shared/*.ts"]);
  assert.equal(formatNote(parsed), AREA);
  assert.deepEqual(parseNote(formatNote(note({ type: "area", globs: ["a/**"] })), "no-provider-branches").globs, ["a/**"]);
});

test("a correction keeps category, count and evidence", () => {
  const parsed = parseNote(CORRECTION, "missing-red-test");
  assert.equal(parsed.category, "testing");
  assert.equal(parsed.count, 3);
  assert.deepEqual(parsed.evidence, ["S2", "corrections/testing/other"]);
  assert.equal(formatNote(parsed), CORRECTION);
  const n = note({ type: "correction", category: "testing", count: 2, evidence: ["S1"] });
  assert.deepEqual(parseNote(formatNote(n), n.slug), n);
});

test("an unknown status or type throws and names the slug", () => {
  assert.throws(() => parseNote(FACT.replace("status: active", "status: maybe"), "odd-one"), /odd-one.*status/);
  assert.throws(() => parseNote(FACT.replace("type: fact", "type: rumor"), "odd-one"), /odd-one.*type/);
});

test("formatNote never writes a backlinks key", () => {
  for (const type of ["area", "decision", "fact", "correction"] as const) {
    assert.doesNotMatch(formatNote(note({ type, category: "x" })), /backlinks/);
  }
});

test("CORRECTION_CATEGORIES lists the starter categories", () => {
  assert.ok(CORRECTION_CATEGORIES.includes("testing"));
});

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notePath, writeNote } from "./memory";

const tmp = () => mkdtempSync(join(tmpdir(), "memory-"));

test("notePath puts each type in its folder", () => {
  assert.equal(notePath(note({ type: "area", slug: "x" })), "areas/x.md");
  assert.equal(notePath(note({ type: "decision", slug: "x" })), "decisions/x.md");
  assert.equal(notePath(note({ type: "fact", slug: "x" })), "notes/x.md");
  assert.equal(notePath(note({ type: "correction", slug: "x", category: "testing" })), "corrections/testing/x.md");
  assert.throws(() => notePath(note({ type: "correction", slug: "x" })), /category/);
});

test("writeNote creates folders and writes the note", () => {
  const root = tmp();
  const n = note({ type: "correction", slug: "x", category: "testing", status: "active" });
  assert.equal(writeNote(root, n), true);
  const file = join(root, ".harness/memory/corrections/testing/x.md");
  assert.equal(readFileSync(file, "utf8"), formatNote(n));
});

test("writeNote with seededOnly leaves a non-seeded note alone", () => {
  const root = tmp();
  const active = note({ type: "fact", slug: "x", status: "active", body: "\nkept\n" });
  const file = join(root, ".harness/memory/notes/x.md");
  writeNote(root, active);
  const before = readFileSync(file, "utf8");
  assert.equal(writeNote(root, note({ type: "fact", slug: "x", status: "seeded", body: "\nnew\n" }), { seededOnly: true }), false);
  assert.equal(readFileSync(file, "utf8"), before);

  writeNote(root, note({ type: "fact", slug: "x", status: "seeded" }));
  assert.equal(writeNote(root, active, { seededOnly: true }), true);
  assert.equal(readFileSync(file, "utf8"), formatNote(active));
  assert.equal(writeNote(root, note({ type: "fact", slug: "fresh" }), { seededOnly: true }), true);
  assert.ok(existsSync(join(root, ".harness/memory/notes/fresh.md")));
});

import { readMemory } from "./memory";

function seedMemory(root: string): void {
  const base = { status: "active" as const };
  writeNote(root, note({ type: "area", slug: "server-harness", globs: ["server/**"], status: "seeded" }));
  writeNote(root, note({ type: "decision", slug: "no-provider-branches", area: "server-harness", ...base }));
  writeNote(
    root,
    note({
      type: "fact",
      slug: "flat-frontmatter",
      area: "server-harness",
      supports: ["decisions/no-provider-branches"],
      supersedes: ["notes/old-frontmatter"],
      citations: [{ path: "server/harness-layout.ts", from: 1, to: 3, hash: "1a2b3c4d" }],
      ...base,
    }),
  );
  writeNote(root, note({ type: "fact", slug: "old-frontmatter", superseded_by: ["notes/flat-frontmatter"], status: "superseded" }));
  writeNote(root, note({ type: "correction", slug: "missing-red-test", category: "testing", area: "server-harness", count: 3, ...base }));
  writeNote(root, note({ type: "correction", slug: "wide-scope", category: "scope", count: 1, ...base }));
  writeFileSync(join(root, ".harness/memory/SUMMARY.md"), "# Memory\n");
  writeFileSync(join(root, ".harness/memory/notes/broken.md"), "not a note");
}

test("readMemory returns areas, notes, backlinks, summary and bad files", () => {
  const root = tmp();
  seedMemory(root);
  const memory = readMemory(root);
  assert.deepEqual(memory.areas.map((a) => [a.slug, a.globs]), [["server-harness", ["server/**"]]]);
  assert.deepEqual(
    memory.notes.map((n) => n.slug).sort(),
    ["flat-frontmatter", "missing-red-test", "no-provider-branches", "old-frontmatter", "wide-scope"],
  );
  const fact = memory.notes.find((n) => n.slug === "flat-frontmatter");
  assert.equal(fact?.citations[0].path, "server/harness-layout.ts");
  assert.equal(memory.summary, "# Memory\n");
  assert.deepEqual(memory.errors.map((e) => e.path), ["notes/broken.md"]);
  assert.match(memory.errors[0].message, /broken/);

  const sorted = (id: string) => [...(memory.backlinks[id] ?? [])].sort((a, b) => a.from.localeCompare(b.from));
  assert.deepEqual(sorted("areas/server-harness"), [
    { from: "corrections/testing/missing-red-test", rel: "area" },
    { from: "decisions/no-provider-branches", rel: "area" },
    { from: "notes/flat-frontmatter", rel: "area" },
  ]);
  assert.deepEqual(sorted("decisions/no-provider-branches"), [{ from: "notes/flat-frontmatter", rel: "supports" }]);
  assert.deepEqual(sorted("notes/old-frontmatter"), [{ from: "notes/flat-frontmatter", rel: "supersedes" }]);
  assert.deepEqual(sorted("notes/flat-frontmatter"), [{ from: "notes/old-frontmatter", rel: "superseded_by" }]);
});

test("readMemory on a missing folder gives empty memory", () => {
  assert.deepEqual(readMemory(tmp()), { areas: [], notes: [], backlinks: {}, summary: "", errors: [] });
});

import { briefFor, type Memory } from "./memory";

function memoryOf(notes: Note[], areas: Note[] = []): Memory {
  return { areas, notes, backlinks: {}, summary: "", errors: [] };
}

const harnessArea = note({ type: "area", slug: "server-harness", globs: ["server/**", "shared/*.ts"] });
const otherArea = note({ type: "area", slug: "ui", globs: ["ui/**"] });
const inArea = (over: Partial<Note>) => note({ type: "fact", area: "server-harness", status: "active", ...over });

test("briefFor matches areas by glob and orders area, facts, corrections", () => {
  const memory = memoryOf(
    [
      inArea({ slug: "seeded-fact", status: "seeded", body: "\nSeeded fact.\n", files: ["server/a.ts"] }),
      inArea({
        slug: "active-fact",
        body: "\nActive fact.\n",
        citations: [{ path: "server/b.ts", from: 2, to: 4, hash: "1a2b3c4d" }],
      }),
      inArea({ slug: "low", type: "correction", category: "testing", count: 1, body: "\nLow.\n" }),
      inArea({ slug: "high", type: "correction", category: "testing", count: 5, body: "\nHigh.\n" }),
      inArea({ slug: "ui-fact", area: "ui", body: "\nUI fact.\n" }),
    ],
    [harnessArea, otherArea],
  );
  assert.deepEqual(briefFor(memory, { step: "implement", paths: ["server/deep/x.ts"] }), [
    "area server-harness: server/**, shared/*.ts",
    "Active fact. — server/b.ts:2-4",
    "Seeded fact. — server/a.ts",
    "High. (×5)",
    "Low. (×1)",
  ]);
  assert.equal(briefFor(memory, { step: "implement", paths: ["shared/x.ts"] })[0], "area server-harness: server/**, shared/*.ts");
  assert.deepEqual(briefFor(memory, { step: "implement", paths: ["shared/deep/x.ts"] }), []);
});

test("briefFor skips other steps, dead statuses and notes with no area", () => {
  const memory = memoryOf(
    [
      inArea({ slug: "plan-only", steps: ["plan"], body: "\nPlan only.\n" }),
      inArea({ slug: "all-steps", body: "\nAll steps.\n" }),
      inArea({ slug: "u", status: "unverified", body: "\nU.\n" }),
      inArea({ slug: "s", status: "superseded", body: "\nS.\n" }),
      inArea({ slug: "e", status: "expired", body: "\nE.\n" }),
      inArea({ slug: "loose", area: null, body: "\nLoose.\n" }),
    ],
    [harnessArea],
  );
  assert.deepEqual(briefFor(memory, { step: "implement", paths: ["server/a.ts"] }), [
    "area server-harness: server/**, shared/*.ts",
    "All steps.",
  ]);
});

test("briefFor cuts at cap", () => {
  const notes = Array.from({ length: 30 }, (_, i) => inArea({ slug: `f${i}`, body: `\nFact ${i}.\n` }));
  assert.equal(briefFor(memoryOf(notes, [harnessArea]), { step: "plan", paths: ["server/a.ts"] }).length, 15);
  assert.equal(briefFor(memoryOf(notes, [harnessArea]), { step: "plan", paths: ["server/a.ts"] }, 4).length, 4);
});
