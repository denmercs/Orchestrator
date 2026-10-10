import assert from "node:assert/strict";
import { test } from "node:test";
import { citationHash, type Note } from "./memory";
import { assignAreas, coChangePairs, dependencyFacts, docDecisions, enforcedRules, historyFacts, matchesGlob, readAreaNames, renderSummary, seedNotes, termAreas, type Commit } from "./repo-facts";

const OPTS = { locked: false, verifiedAt: "2026-03-01" };

test("docDecisions gives one seeded decision per prose or bullet line, verbatim and cited", () => {
  const text = ["# Title", "", "Never call the model from shared/.", "- Notes live in `.harness/memory`."].join("\n");
  const notes = docDecisions("CONTEXT.md", text, OPTS);
  assert.equal(notes.length, 2);
  const [prose, bullet] = notes;
  assert.equal(prose.type, "decision");
  assert.equal(prose.status, "seeded");
  assert.deepEqual([prose.steps, prose.learned_in], [[], []]);
  assert.equal(prose.verified_at, "2026-03-01");
  assert.equal(prose.area, null);
  assert.equal(prose.body, "Never call the model from shared/.");
  const hash = citationHash(["Never call the model from shared/."]);
  assert.deepEqual(prose.citations, [{ path: "CONTEXT.md", from: 3, to: 3, hash }]);
  assert.equal(prose.slug, `context-never-call-the-model-from-${hash}`);
  assert.equal(bullet.body, "- Notes live in `.harness/memory`.");
  assert.equal(bullet.citations[0].from, 4);
});

test("docDecisions skips headings, fences, tables and blank lines", () => {
  const text = [
    "## Heading",
    "```mermaid",
    "graph TD",
    "```",
    "| a | b |",
    "|---|---|",
    "~~~",
    "inside a tilde fence",
    "~~~",
    "",
    "Kept.",
  ].join("\n");
  assert.deepEqual(
    docDecisions("README.md", text, OPTS).map((n) => n.body),
    ["Kept."],
  );
});

test("a locked architecture.md keeps only lines under ## decisions", () => {
  const text = ["# Arch", "Intro prose.", "## Decisions", "Use one queue.", "- Keep it pure.", "## Risks", "Risk prose."].join("\n");
  const path = ".harness/initiatives/x/architecture.md";
  assert.deepEqual(
    docDecisions(path, text, { ...OPTS, locked: true }).map((n) => n.body),
    ["Use one queue.", "- Keep it pure."],
  );
  assert.deepEqual(docDecisions(path, text, OPTS), []);
});

test("areaOf picks the area for a line, defaulting to null", () => {
  const notes = docDecisions("CONTEXT.md", "See `server/a.ts`.", { ...OPTS, areaOf: (_line, n) => (n === 1 ? "server" : null) });
  assert.equal(notes[0].area, "server");
});

test("termAreas makes one area per ## term citing tracked paths or globs, skipping the rest", () => {
  const text = [
    "# Context",
    "## Context Pill",
    "Shown by `client/context-pill-*` and `server/pill.ts`; see `missing/gone.ts` and `Note`.",
    "## Ghost Term",
    "Lives in `nowhere/at-all.ts`.",
    "## Plain Term",
    "No paths here, just `words`.",
    "## Shared Code",
    "Under `shared/**`.",
  ].join("\n");
  const files = ["client/context-pill-a.tsx", "client/context-pill-b.css", "server/pill.ts", "shared/x/y.ts"];
  const areas = termAreas(text, files, "2026-03-01");
  assert.deepEqual(areas.map((a) => a.slug), ["context-pill", "shared-code"]);
  const [pill, shared] = areas;
  assert.equal(pill.type, "area");
  assert.equal(pill.status, "seeded");
  assert.equal(pill.verified_at, "2026-03-01");
  assert.deepEqual(pill.globs, ["client/context-pill-*", "server/pill.ts"]);
  assert.deepEqual(pill.citations, [{ path: "CONTEXT.md", from: 2, to: 2, hash: citationHash(["## Context Pill"]) }]);
  assert.deepEqual(shared.globs, ["shared/**"]);
  assert.equal(shared.citations[0].from, 8);
});

test("matchesGlob handles * within a segment and ** across folders", () => {
  assert.equal(matchesGlob("client/context-pill-*", "client/context-pill-a.tsx"), true);
  assert.equal(matchesGlob("client/context-pill-*", "client/sub/context-pill-a.tsx"), false);
  assert.equal(matchesGlob("shared/**", "shared/x/y.ts"), true);
  assert.equal(matchesGlob("server/pill.ts", "server/pill.ts"), true);
  assert.equal(matchesGlob("server/pill.ts", "server/pill.tsx"), false);
});

let counter = 0;
function commit(files: string[], subject = "Change"): Commit {
  counter += 1;
  return { sha: `${String(counter).padStart(7, "0")}${"f".repeat(33)}`, subject, date: "2026-02-01", files };
}
const many = (n: number, files: string[], subject?: string) => Array.from({ length: n }, () => commit(files, subject));
const short = (c: Commit) => c.sha.slice(0, 7);
const ofKind = (notes: ReturnType<typeof historyFacts>, kind: string) => notes.filter((n) => n.extra.kind === kind);

test("historyFacts hotspots need 5 commits, ignore lockfile and .harness, and carry short shas, no citation", () => {
  const five = many(5, ["a.ts", "package-lock.json", ".harness/state.md"]);
  const commits = [...five, ...many(4, ["b.ts", "package-lock.json"]), ...many(2, ["package-lock.json", ".harness/x.md"])];
  const hot = ofKind(historyFacts(commits, "2026-03-01"), "hotspot");
  assert.deepEqual(hot.map((n) => n.slug), ["hotspot-a-ts"]);
  const [note] = hot;
  assert.equal(note.type, "fact");
  assert.equal(note.status, "seeded");
  assert.equal(note.verified_at, "2026-03-01");
  assert.deepEqual(note.files, ["a.ts"]);
  assert.deepEqual(note.citations, []);
  assert.deepEqual(note.extra.commits, five.map(short));
});

test("historyFacts caps hotspots at 10 and co-change at 20, ties broken by path", () => {
  const files = Array.from({ length: 12 }, (_, i) => `f${String(i + 1).padStart(2, "0")}.ts`);
  const notes = historyFacts(many(5, [...files].reverse()), "2026-03-01");
  assert.deepEqual(ofKind(notes, "hotspot").map((n) => n.files[0]), files.slice(0, 10));
  const pairs = ofKind(notes, "co-change");
  assert.equal(pairs.length, 20);
  assert.deepEqual(pairs[0].files, ["f01.ts", "f02.ts"]);
  assert.deepEqual(pairs[19].files, ["f02.ts", "f11.ts"]);
  assert.deepEqual(historyFacts(many(5, files), "2026-03-01").map((n) => n.slug), notes.map((n) => n.slug));
});

test("historyFacts co-change needs 3 shared commits and confidence shared/min(commits) >= 0.5, skipping bulk commits", () => {
  const ab = many(3, ["a.ts", "b.ts", "package-lock.json", ".harness/state.md"]);
  const bulk = commit(["a.ts", "b.ts", ...Array.from({ length: 39 }, (_, i) => `bulk/${i}.ts`)]);
  const commits = [
    ...ab,
    bulk,
    ...many(2, ["c.ts", "d.ts"]),
    ...many(3, ["e.ts", "f.ts"]), ...many(3, ["e.ts"]), ...many(3, ["f.ts"]),
    ...many(3, ["g.ts", "h.ts"]), ...many(4, ["g.ts"]), ...many(4, ["h.ts"]),
  ];
  const pairs = ofKind(historyFacts(commits, "2026-03-01"), "co-change");
  assert.deepEqual(pairs.map((n) => n.slug), ["co-change-a-ts-b-ts", "co-change-e-ts-f-ts"]);
  assert.deepEqual(pairs[0].files, ["a.ts", "b.ts"]);
  assert.deepEqual(pairs[0].citations, []);
  assert.deepEqual(pairs[0].extra.commits, ab.map(short));
  assert.equal(pairs[0].extra.kind, "co-change");

  const all = coChangePairs(commits);
  const ef = all.find((p) => p.a === "e.ts" && p.b === "f.ts");
  assert.deepEqual([ef?.shared, ef?.jaccard], [3, 3 / 9]);
  assert.equal(all.find((p) => p.a === "a.ts" && p.b === "b.ts")?.shared, 3);
  assert.equal(all.some((p) => p.a === "package-lock.json" || p.b.startsWith(".harness/") || p.a.startsWith("bulk/")), false);
});

test("historyFacts refix needs 3 fix commits touching the file", () => {
  const fixes = [commit(["x.ts"], "Fix crash"), commit(["x.ts"], "fixes the loader"), commit(["x.ts"], "fix: leak")];
  const commits = [
    ...fixes,
    commit(["x.ts"], "Add feature"),
    ...many(2, ["y.ts"], "Fix typo"),
    ...many(2, ["z.ts"], "Fix it"), commit(["z.ts"], "Update prefix handling"),
  ];
  const refix = ofKind(historyFacts(commits, "2026-03-01"), "refix");
  assert.deepEqual(refix.map((n) => n.slug), ["refix-x-ts"]);
  assert.deepEqual(refix[0].files, ["x.ts"]);
  assert.deepEqual(refix[0].citations, []);
  assert.deepEqual(refix[0].extra.commits, fixes.map(short));
});

test("assignAreas puts term files first, clusters unclaimed co-changers, then falls back to folder, entry or root", () => {
  const files = [
    "server/context-meter.ts", "client/pill.tsx", "client/pill.css", "server/alpha.ts", "shared/beta.ts",
    "client/solo.ts", "client/mate.ts", "server/other.ts", "docs/guide.md", "README.md", "index.ts",
    "server/scope.ts", "server/scope.test.ts", "package-lock.json", ".harness/state.md",
  ];
  const [term] = termAreas("## Context meter\n`server/context-meter.ts`\n", files, "2026-03-01");
  const commits = [
    ...many(3, ["server/context-meter.ts", "client/pill.tsx", "client/pill.css", "package-lock.json", ".harness/state.md"]),
    ...many(3, ["server/alpha.ts", "shared/beta.ts"]),
    ...many(3, ["client/solo.ts", "client/mate.ts"]), ...many(3, ["client/solo.ts"]), ...many(3, ["client/mate.ts"]),
    ...many(2, ["server/other.ts", "docs/guide.md"]),
    ...many(3, ["server/scope.ts", "server/scope.test.ts"]),
  ];
  const { areas, primaryArea } = assignAreas(files, [term], commits, "2026-03-01");
  assert.deepEqual(areas.map((a) => [a.slug, a.globs]), [
    ["context-meter", ["server/context-meter.ts"]],
    ["pill", ["client/pill.css", "client/pill.tsx"]],
    ["server-alpha", ["server/alpha.ts", "shared/beta.ts"]],
    ["scope", ["server/scope.test.ts", "server/scope.ts"]],
    ["client", ["client/**"]],
    ["docs", ["docs/**"]],
    ["entry", ["index.ts"]],
    ["root", ["README.md"]],
    ["server", ["server/**"]],
  ]);
  assert.deepEqual(areas[0].citations, term.citations);
  for (const a of areas.slice(1)) {
    assert.deepEqual([a.type, a.status, a.citations, a.verified_at], ["area", "seeded", [], "2026-03-01"]);
  }
  const primary = (f: string) => primaryArea(f);
  assert.equal(primary("server/context-meter.ts"), "context-meter");
  assert.equal(primary("client/pill.css"), "pill");
  assert.equal(primary("shared/beta.ts"), "server-alpha");
  assert.equal(primary("client/solo.ts"), "client");
  assert.equal(primary("server/other.ts"), "server");
  assert.equal(primary("README.md"), "root");
  assert.equal(primary("index.ts"), "entry");
  assert.equal(primary("server/scope.test.ts"), "scope");
  assert.equal(primary("package-lock.json"), null);
  assert.equal(primary(".harness/state.md"), null);
  assert.deepEqual(assignAreas([...files].reverse(), [term], [...commits].reverse(), "2026-03-01").areas, areas);
});

test("dependencyFacts emits one fact per area pair, citing the first import line, ignoring self-edges and packages", () => {
  const src = (path: string, ...lines: string[]) => ({ path, text: lines.join("\n") });
  const files = [
    src("client/a.ts", "import fs from 'node:fs';", "import { x } from '../server/one';", "import y from \"../server/two.js\";", "import './b';"),
    src("client/b.tsx", "export { z } from '../shared/util';", "const m = await import('../server/one');"),
    src("server/one.ts", "import { u } from '../shared/util';", "import react from 'react';"),
    src("server/two.ts", "export const two = 1;"),
    src("shared/util/index.ts", "import { a } from '../../client/a';"),
    src("README.md", "import x from './nope';"),
  ];
  const { primaryArea } = assignAreas(files.map((f) => f.path), [], [], "2026-03-01");
  const facts = dependencyFacts([...files].reverse(), { primaryArea }, "2026-03-01");
  assert.deepEqual(facts.map((n) => n.slug), ["dependency-client-to-server", "dependency-client-to-shared", "dependency-server-to-shared", "dependency-shared-to-client"]);
  const [cs] = facts;
  assert.deepEqual([cs.type, cs.status, cs.area, cs.extra.kind, cs.verified_at], ["fact", "seeded", "client", "dependency", "2026-03-01"]);
  assert.equal(cs.body, "client imports server");
  assert.deepEqual(cs.citations, [{ path: "client/a.ts", from: 2, to: 2, hash: citationHash(["import { x } from '../server/one';"]) }]);
  assert.deepEqual(facts[1].citations[0].path, "client/b.tsx");
  assert.equal(facts[3].citations[0].path, "shared/util/index.ts");
});

test("enforcedRules cites one line per tsconfig option, package script, eslint rule and workflow run, outside any area", () => {
  const src = (path: string, ...lines: string[]) => ({ path, text: lines.join("\n") });
  const tsconfig = src("tsconfig.json", "{", "  // strictness", '  "compilerOptions": {', '    "strict": true,', '    "paths": {', '      "@/*": ["./src/*"]', "    },", '    "noUncheckedIndexedAccess": true', "  },", '  "include": ["src"]', "}");
  const pkg = src("package.json", "{", '  "name": "x",', '  "scripts": {', '    "test": "node --test",', '    "typecheck": "tsc --noEmit"', "  },", '  "dependencies": {', '    "left-pad": "1.0.0"', "  }", "}");
  const eslint = src("eslint.config.js", "export default [{", "  rules: {", "    'no-console': 'error',", "    '@typescript-eslint/no-explicit-any': ['warn', { fixToUnknown: true }],", "  },", "}];");
  const flow = src(".github/workflows/ci.yml", "jobs:", "  test:", "    steps:", "      - uses: actions/checkout@v4", "      - run: npm ci", "      - name: Check", "        run: |", "          npm test", "          npm run typecheck");
  const files = [flow, pkg, src("README.md", '"scripts": {', "run: nope"), eslint, tsconfig];
  const facts = enforcedRules(files, "2026-03-01");
  const view = (n: Note) => [n.slug, n.body, n.citations[0].path, n.citations[0].from];
  assert.deepEqual(facts.map(view), [
    ["enforced-ci-run-5", "- run: npm ci", ".github/workflows/ci.yml", 5],
    ["enforced-ci-run-7", "run: |", ".github/workflows/ci.yml", 7],
    ["enforced-eslint-config-no-console", "'no-console': 'error',", "eslint.config.js", 3],
    ["enforced-eslint-config-typescript-eslint-no-explicit-any", "'@typescript-eslint/no-explicit-any': ['warn', { fixToUnknown: true }],", "eslint.config.js", 4],
    ["enforced-package-test", '"test": "node --test",', "package.json", 4],
    ["enforced-package-typecheck", '"typecheck": "tsc --noEmit"', "package.json", 5],
    ["enforced-tsconfig-nouncheckedindexedaccess", '"noUncheckedIndexedAccess": true', "tsconfig.json", 8],
    ["enforced-tsconfig-paths", '"paths": {', "tsconfig.json", 5],
    ["enforced-tsconfig-strict", '"strict": true,', "tsconfig.json", 4],
  ]);
  const [first] = facts;
  assert.deepEqual([first.type, first.status, first.area, first.extra.kind, first.verified_at], ["fact", "seeded", null, "enforced", "2026-03-01"]);
  assert.deepEqual(first.citations[0], { path: ".github/workflows/ci.yml", from: 5, to: 5, hash: citationHash(["      - run: npm ci"]) });
  assert.deepEqual(enforcedRules([...files].reverse(), "2026-03-01"), facts);
});

test("renderSummary and readAreaNames round-trip ids to names", () => {
  const { areas } = assignAreas(["client/a.ts", "server/a.ts"], [], [], "2026-03-01");
  const text = renderSummary(areas, new Map([["server", 4]]));
  assert.match(text, /\| client \| client \| client\/\*\* \| 0 \|/);
  assert.match(text, /\| server \| server \| server\/\*\* \| 4 \|/);
  assert.deepEqual([...readAreaNames(text)], [["client", "client"], ["server", "server"]]);
  const edited = text.replace("| server | server |", "| server | backend |");
  assert.equal(readAreaNames(edited).get("server"), "backend");
  assert.equal(renderSummary(areas, { server: 4 }), text);
});

test("seedNotes composes the cycles, applies area names and merges areas that share one", () => {
  const src = (path: string, ...lines: string[]) => ({ path, text: lines.join("\n") });
  const files = [
    src("CONTEXT.md", "# Context", "## Pill", "Shown by `client/pill.ts`."),
    src("README.md", "Run `server/a.ts` first."),
    src("client/pill.ts", "export const pill = 1;"),
    src("client/x.ts", "export const x = 1;"),
    src("server/a.ts", "import { u } from '../shared/u';"),
    src("shared/u.ts", "export const u = 1;"),
  ];
  const commits = ["c1", "c2", "c3", "c4", "c5"].map((sha) => ({ sha: `${sha}0000000`, subject: "work", date: "2026-02-01", files: ["server/a.ts"] }));
  const snapshot = { files, commits, harnessDocs: [], verifiedAt: "2026-03-01" };

  const plain = seedNotes(snapshot);
  assert.deepEqual(plain.notes.filter((n) => n.type === "area").map((n) => n.slug), ["pill", "client", "root", "server", "shared"]);
  assert.match(plain.summary, /\| server \| server \| server\/\*\* \| 3 \|/);
  assert.ok(plain.notes.every((n) => n.status === "seeded" && n.verified_at === "2026-03-01"));

  const names = new Map([["server", "backend"], ["client", "ui"], ["shared", "ui"]]);
  const { notes, summary } = seedNotes({ ...snapshot, areaNames: names });
  const slugs = notes.map((n) => `${n.type}/${n.slug}`);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.deepEqual(notes.filter((n) => n.type === "area").map((n) => n.slug), ["pill", "ui", "root", "backend"]);
  assert.deepEqual(notes.find((n) => n.slug === "ui")?.globs, ["client/**", "shared/**"]);
  assert.equal(notes.find((n) => n.slug === "hotspot-server-a-ts")?.area, "backend");
  assert.equal(notes.find((n) => n.slug === "dependency-server-to-shared")?.area, "backend");
  assert.equal(notes.find((n) => n.type === "decision" && n.body.startsWith("Run"))?.area, "backend");
  assert.equal(notes.find((n) => n.type === "decision" && n.body.startsWith("Shown"))?.area, "pill");
  assert.deepEqual([...readAreaNames(summary)], [["pill", "pill"], ["client", "ui"], ["root", "root"], ["server", "backend"], ["shared", "ui"]]);
  assert.deepEqual(seedNotes({ ...snapshot, areaNames: names }), { notes, summary });
});

test("docDecisions skips frontmatter, horizontal rules and HTML comments", () => {
  const text = ["---", "status: accepted", "---", "", "Kept one.", "---", "<!-- a note -->", "<!--", "multi", "-->", "Kept two."].join("\n");
  assert.deepEqual(docDecisions("adr.md", text, OPTS).map((n) => n.body), ["Kept one.", "Kept two."]);
});

test("assignAreas keeps area ids unique and non-empty", () => {
  const files = ["server/a.ts", "server/b.ts", "___/x.ts", "___/y.ts"];
  const [term] = termAreas("## Server\n`server/a.ts`\n", files, "2026-03-01");
  const { areas, primaryArea } = assignAreas(files, [term], [], "2026-03-01");
  const slugs = areas.map((a) => a.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.ok(slugs.every((s) => /^[a-z0-9]/.test(s)));
  assert.equal(primaryArea("server/a.ts"), "server");
  assert.notEqual(primaryArea("server/b.ts"), "server");
});
