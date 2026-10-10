// render(data) on fixture rows: task success per arm, the does-not-ship rule, and the empty case.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, completeRounds, parseLabels, render, successByArm, labelKey, tokensByArm, dedupeSample, correctionRepeats, decisions, parseDedupeLabels, dedupeTally } from "./verdict.mjs";

const SECTIONS = ["## Task success", "## Tokens and exploration", "## Dedupe accuracy", "## Repeat rate per area and category", "## Decisions"];
const row = (story, round, kind, arm, outcome, extra = {}) => ({
  run: "r", initiative: "i", story, round, kind, arm, outcome,
  explore: null, tokens: { used: 1, costUsd: 0 }, judgeCostUsd: 0, marker: null, plan: false, at: "", ...extra,
});
const out = (caught, notCaught, nw = []) => ({ caught, notCaught, new: nw });

const rows = [
  row("S1", 1, "failed", "none", out(["a"], ["b"])),
  row("S1", 2, "failed", "none", out(["c"], [])),
  row("S1", 1, "failed", "facts", out(["a"], ["b"], ["n1", "n2"])),
  row("S1", 2, "failed", "facts", out(["c"], [], ["n3"])),
  row("S1", 1, "failed", "facts+corrections", out([], ["a", "b"], ["w1"])),
  row("S1", 2, "failed", "facts+corrections", out(["c"], [])),
  row("S2", 1, "control", "none", out([], [])),
  row("S2", 1, "control", "facts", out([], [], ["n4"])),
  row("S2", 1, "control", "facts+corrections", out([], [])),
  row("S9", 1, "failed", "none", null),
  row("S9", 2, "failed", "none", out(["x"], []), { error: "boom" }),
  row("S9", 3, "failed", "none", out(["x"], []), { stopped: "cap" }),
];
const labels = {
  "S1|1|facts|n1": "yes",
  "S1|1|facts|n2": "no",
  "S1|2|facts|n3": "yes",
  "S1|1|facts+corrections|w1": "no",
};

test("successByArm: counts per arm, n, and the does-not-ship rule", () => {
  const by = Object.fromEntries(successByArm(rows, labels).map((a) => [a.arm, a]));
  assert.deepEqual(
    { ...by.none },
    { arm: "none", nFailed: 2, nControl: 1, caught: 2, missed: 1, validNew: 0, wrongNew: 0, unlabelled: 0, doesNotShip: false },
  );
  assert.deepEqual(
    { ...by.facts },
    { arm: "facts", nFailed: 2, nControl: 1, caught: 2, missed: 1, validNew: 2, wrongNew: 1, unlabelled: 1, doesNotShip: true },
  );
  assert.equal(by["facts+corrections"].caught, 1);
  assert.equal(by["facts+corrections"].doesNotShip, true);
});

test("successByArm: fewer catches alone trips the rule; equal catches and no wrong new does not", () => {
  const few = [
    row("S1", 1, "failed", "none", out(["a"], [])),
    row("S1", 1, "failed", "facts", out([], ["a"])),
    row("S1", 1, "failed", "facts+corrections", out(["a"], [], ["n"])),
  ];
  const by = Object.fromEntries(successByArm(few, { "S1|1|facts+corrections|n": "yes" }).map((a) => [a.arm, a]));
  assert.equal(by.facts.doesNotShip, true);
  assert.equal(by["facts+corrections"].doesNotShip, false);
});

test("render: heading, preamble, Task success first, per-arm lines", () => {
  const text = render({ rows, labels });
  assert.ok(text.startsWith("# Memory replay verdict\n"));
  for (const w of ["Goal", "Acceptance", "Notes"]) assert.ok(text.includes(w), w);
  const heading = text.indexOf("## Task success");
  assert.ok(heading > text.indexOf("Notes"), "preamble comes before the section");
  assert.deepEqual(text.match(/^## .*/gm), SECTIONS, "sections in order");
  assert.match(text, /\| facts \| 2 failed, 1 control \| 2 \| 1 \| 2 \| 1 \| 1 \|/);
  assert.match(text, /\| none \| 2 failed, 1 control \| 2 \| 1 \| 0 \| 0 \| 0 \|/);
  assert.equal((text.match(/\*\*does not ship\*\*/g) ?? []).length, 2);
  assert.match(text, /n = 3 rounds replayed/);
  assert.equal(render({ rows, labels }), render({ rows: structuredClone(rows), labels }));
});

test("render: no rows prints no replay data, n = 0 and no table", () => {
  for (const data of [{ rows: [], labels: {} }, { rows: [rows[9], rows[10], rows[11]], labels: {} }]) {
    const text = render(data);
    assert.match(text, /## Task success/);
    assert.match(text, /## Tokens and exploration\n\nno replay data\n\nn = 0/);
    assert.match(text, /no replay data/);
    assert.match(text, /n = 0/);
    assert.ok(!text.includes("|"), "no empty tables");
    assert.ok(!text.includes("does not ship"));
  }
});

test("parseLabels: yes/no lines map to labelKey; unlabelled and other lines are omitted", () => {
  const text = [
    "# New findings",
    "- [x] yes — S3 r2 facts: a finding",
    "- [x] no — S3 r2 facts+corrections: has: colons: inside",
    "- [ ] yes / no — S3 r2 none: untouched",
    "- [ ] yes — S4 r1 none: unchecked box still labelled",
    "",
  ].join("\n");
  const got = parseLabels(text);
  assert.deepEqual(got, {
    "S3|2|facts|a finding": "yes",
    "S3|2|facts+corrections|has: colons: inside": "no",
    "S4|1|none|unchecked box still labelled": "yes",
  });
  assert.equal(labelKey({ story: "S3", round: 2, arm: "facts" }, "a finding"), "S3|2|facts|a finding");
});

test("completeRounds: a round needs all three arms with an outcome; error and cap rows are listed with a reason", () => {
  const set = (story, round, over = {}) => ["none", "facts", "facts+corrections"].map((arm) => row(story, round, "failed", arm, out(["a"], []), over[arm] ?? {}));
  const full = set("A", 1);
  const partial = [row("B", 1, "failed", "none", out([], [])), row("B", 1, "failed", "facts", out([], []))];
  const nullOutcome = set("C", 1).map((r, i) => (i === 0 ? { ...r, outcome: null } : r));
  const errored = set("D", 1, { facts: { error: "boom" } });
  const capped = set("E", 1, { none: { stopped: "cap" } });
  const { complete, leftOut } = completeRounds([...full, ...partial, ...nullOutcome, ...errored, ...capped]);
  assert.deepEqual(complete, full);
  assert.deepEqual(
    leftOut.map((l) => [l.story, l.round, l.arm, l.reason]),
    [["C", 1, "none", "no outcome"], ["D", 1, "facts", "error: boom"], ["E", 1, "none", "stopped: cap"]],
  );
});

test("successByArm and render leave a whole round out when one arm errored", () => {
  const arms = ["none", "facts", "facts+corrections"];
  const ok = arms.map((a) => row("A", 1, "failed", a, out(["a"], [])));
  const bad = arms.map((a) => row("D", 1, "failed", a, out(["z"], []), a === "facts" ? { error: "boom" } : {}));
  const by = successByArm([...ok, ...bad], {});
  for (const a of by) assert.equal(a.caught, 1, a.arm);
  const text = render({ rows: [...ok, ...bad], labels: {} });
  assert.match(text, /Left out of the comparison/);
  assert.match(text, /D, round 1, facts: error: boom/);
  assert.match(text, /n = 1 rounds replayed/);
});

const ex = (reads, files, chars) => ({ reads, searches: 0, files, chars, edited: false });
const tk = (used, costUsd) => ({ used, costUsd });
const tokRows = [
  ["A", { none: [tk(100, 1), ex(4, 3, 1000)], facts: [tk(150, 2), ex(6, 4, 1500)], "facts+corrections": [tk(90, null), null] }],
  ["B", { none: [tk(200, 2), ex(2, 2, 400)], facts: [tk(250, 2), ex(3, 3, 500)], "facts+corrections": [tk(180, 1), null] }],
  ["C", { none: [tk(600, 3), null], facts: [tk(700, 5), ex(5, 5, 900)], "facts+corrections": [tk(400, 2), null] }],
].flatMap(([story, arms]) =>
  Object.entries(arms).map(([arm, [tokens, explore]]) => row(story, 1, "failed", arm, out(["a"], []), { tokens, explore })),
);
const errored = row("D", 1, "failed", "facts", out([], []), { error: "boom", tokens: tk(99999, 99), explore: ex(99, 99, 99999) });

test("tokensByArm: median and total over non-null values, odd and even counts, and paired median delta vs none", () => {
  const by = Object.fromEntries(tokensByArm([...tokRows, errored]).map((a) => [a.arm, a]));
  assert.deepEqual(by.none.tokens, { n: 3, median: 200, total: 900 });
  assert.deepEqual(by.none.cost, { n: 3, median: 2, total: 6 });
  assert.deepEqual(by.none.explore.reads, { n: 2, median: 3, total: 6 });
  assert.deepEqual(by.none.explore.files, { n: 2, median: 2.5, total: 5 });
  assert.deepEqual(by.none.explore.chars, { n: 2, median: 700, total: 1400 });
  assert.equal(by.none.delta, null, "none has no delta against itself");
  assert.deepEqual(by.facts.tokens, { n: 3, median: 250, total: 1100 }, "error round left out");
  assert.deepEqual(by.facts.cost, { n: 3, median: 2, total: 9 });
  assert.deepEqual(by.facts.explore.chars, { n: 3, median: 900, total: 2900 });
  assert.deepEqual(by.facts.delta, { tokens: { n: 3, median: 50 }, cost: { n: 3, median: 1 }, chars: { n: 2, median: 300 } });
  assert.deepEqual(by["facts+corrections"].cost, { n: 2, median: 1.5, total: 3 });
  assert.deepEqual(by["facts+corrections"].explore.chars, { n: 0, median: null, total: 0 });
  assert.deepEqual(by["facts+corrections"].delta, { tokens: { n: 3, median: -20 }, cost: { n: 2, median: -1 }, chars: { n: 0, median: null } });
});

test("render: Tokens and exploration states n, the typed-calls note and a per-arm table", () => {
  const text = render({ rows: tokRows, labels: {} });
  const section = text.slice(text.indexOf("## Tokens and exploration"));
  assert.match(section, /n = 3 complete rounds/);
  assert.match(section, /Exploration counts typed calls only \(Read, Grep, Glob\) until S9 merges/);
  assert.match(section, /\| facts \| 250 \| 1100 \|/);
  assert.match(section, /\| none \| 200 \| 900 \|/);
});

const corr = (slug, category, area, count, evidence = []) => ({ slug, type: "correction", category, area, count, evidence });
const memory = {
  notes: [
    corr("a", "testing", "server", 3, ["e1", "e2", "e3"]),
    corr("b", "testing", "server", 1, ["e4"]),
    corr("c", "types", "client", 2, ["e5", "e6"]),
    corr("d", "types", "client", 5, ["e7", "e8"]),
    { slug: "f", type: "fact", category: null, area: "server", count: 9, evidence: [] },
  ],
};
const bigMemory = { notes: Array.from({ length: 50 }, (_, i) => corr(`n${i}`, "testing", "server", 2 + (i % 3), [`x${i}`, `y${i}`])) };

test("dedupeSample: deterministic per seed, only count >= 2 corrections, at most n, pair evidence kept", () => {
  const one = dedupeSample(memory, 30, 1);
  assert.deepEqual(one, dedupeSample(memory, 30, 1));
  assert.deepEqual(one.map((x) => x.id).sort(), ["corrections/testing/a", "corrections/types/c", "corrections/types/d"]);
  const a = one.find((x) => x.id === "corrections/testing/a");
  assert.deepEqual({ category: a.category, area: a.area, pair: a.pair }, { category: "testing", area: "server", pair: ["e1", "e2", "e3"] });
  assert.deepEqual(dedupeSample({ notes: [] }, 30, 1), []);
  const big = dedupeSample(bigMemory, 30, 7);
  assert.equal(big.length, 30);
  assert.equal(new Set(big.map((x) => x.id)).size, 30, "no note drawn twice");
  assert.notDeepEqual(big.map((x) => x.id), dedupeSample(bigMemory, 30, 8).map((x) => x.id), "a different seed changes the draw");
  assert.equal(dedupeSample(bigMemory, 5, 7).length, 5);
});

test("parseDedupeLabels and dedupeTally: `- [x] yes — <id>` lines; untouched lines omitted", () => {
  const got = parseDedupeLabels(["# Dedupe sample", "- [x] yes — corrections/testing/a", "- [x] no — corrections/types/c", "- [ ] yes / no — corrections/types/d", ""].join("\n"));
  assert.deepEqual(got, { "corrections/testing/a": "yes", "corrections/types/c": "no" });
  assert.deepEqual(dedupeTally(got), { sampled: 2, duplicates: 1 });
  assert.deepEqual(dedupeTally({}), { sampled: 0, duplicates: 0 });
});

test("correctionRepeats: per (area, category) observations and repeats, overall %, source replay memory", () => {
  const r = correctionRepeats(memory, []);
  assert.equal(r.source, "replay memory");
  assert.deepEqual(r.rows, [
    { area: "client", category: "types", observations: 7, repeats: 5 },
    { area: "server", category: "testing", observations: 4, repeats: 2 },
  ]);
  assert.deepEqual({ observations: r.observations, repeats: r.repeats, overall: r.overall }, { observations: 11, repeats: 7, overall: (7 / 11) * 100 });
});

test("correctionRepeats: no corrections falls back to the labelled baseline rows", () => {
  const baseline = [{ area: "server", category: "testing", findings: 10, repeats: 2 }, { area: "client", category: "types", findings: 5, repeats: 1 }];
  for (const m of [{ notes: [] }, { notes: [{ slug: "f", type: "fact", count: 1, evidence: [] }] }, undefined]) {
    const r = correctionRepeats(m, baseline);
    assert.equal(r.source, "baseline keyword guess");
    assert.deepEqual(r.rows, [
      { area: "client", category: "types", observations: 5, repeats: 1 },
      { area: "server", category: "testing", observations: 10, repeats: 2 },
    ]);
    assert.deepEqual({ observations: r.observations, repeats: r.repeats, overall: r.overall }, { observations: 15, repeats: 3, overall: 20 });
  }
  assert.equal(correctionRepeats({ notes: [] }, []).overall, null);
});

const roundsOf = (nFailed, nControl, over = {}) => {
  const rs = [];
  for (let i = 0; i < nFailed + nControl; i++) {
    for (const arm of ["none", "facts", "facts+corrections"]) {
      rs.push(row(`S${i}`, 1, i < nFailed ? "failed" : "control", arm, out(["a"], []), over[arm] ?? {}));
    }
  }
  return rs;
};
const baseline = [{ area: "server", category: "testing", findings: 15, repeats: 3 }];

test("decisions: arms ship or not, and the sample minimum rule", () => {
  const lines = decisions({ rows, labels, memory: { notes: [] }, baseline });
  assert.ok(lines.includes("facts: provisional, does not ship"));
  assert.ok(lines.includes("facts+corrections: provisional, does not ship"));
  assert.ok(lines.includes("insufficient data, Phase 2 builds facts only"));
  assert.ok(lines.some((l) => /n = 2 failed, 1 control/.test(l)), "n's are stated");
  const enough = decisions({ rows: roundsOf(20, 20), labels: {}, memory: { notes: [] }, baseline });
  assert.ok(enough.includes("facts: ships"));
  assert.ok(!enough.includes("insufficient data, Phase 2 builds facts only"));
  assert.ok(enough.some((l) => /meets d1's minimum/.test(l) && /n = 20 failed, 20 control/.test(l)));
  const short = decisions({ rows: roundsOf(20, 19), labels: {}, memory: { notes: [] }, baseline });
  assert.ok(short.includes("insufficient data, Phase 2 builds facts only"), "19 control is under the minimum");
});

test("decisions: repeat rate under 25% builds only corrections-to-checks, provisional on the baseline fallback", () => {
  const prov = decisions({ rows: [], labels: {}, memory: { notes: [] }, baseline });
  assert.ok(prov.some((l) => l.includes("build only the corrections-to-checks path") && l.includes("(provisional: keyword guess)") && l.includes("20%")));
  const low = { notes: [corr("a", "testing", "server", 2, ["p", "q"]), corr("b", "testing", "server", 1), corr("c", "testing", "server", 1), corr("d", "testing", "server", 1), corr("e", "testing", "server", 1), corr("f", "testing", "server", 1), corr("g", "testing", "server", 1)] };
  const real = decisions({ rows: [], labels: {}, memory: low, baseline });
  assert.ok(real.some((l) => l.includes("build only the corrections-to-checks path") && !l.includes("provisional")));
  const high = decisions({ rows: [], labels: {}, memory, baseline });
  assert.ok(!high.some((l) => l.includes("corrections-to-checks")));
  assert.ok(high.some((l) => /repeat rate 64%/.test(l)));
});

test("decisions: no replay data says the arms cannot be decided", () => {
  const lines = decisions({ rows: [], labels: {}, memory: { notes: [] }, baseline });
  assert.ok(lines.some((l) => /arms cannot be decided/.test(l)));
  assert.ok(!lines.some((l) => /: (ships|does not ship)$/.test(l)));
  assert.ok(lines.includes("insufficient data, Phase 2 builds facts only"));
  assert.ok(lines.some((l) => /n = 0 failed, 0 control/.test(l)));
});

test("render: Dedupe accuracy, Repeat rate and Decisions sections", () => {
  const full = render({ rows, labels, memory, baseline, dedupe: { sampled: 4, duplicates: 3 } });
  assert.deepEqual(full.match(/^## .*/gm), SECTIONS);
  assert.match(full, /## Dedupe accuracy\n\nn = 4 sampled pairs; 3 marked as true duplicates \(75%\)/);
  assert.match(full, /Source: replay memory/);
  assert.match(full, /\| client \| types \| 7 \| 5 \|/);
  assert.match(full, /## Decisions\n\n- facts: provisional, does not ship/);
  const empty = render({ rows: [], labels: {}, baseline });
  assert.match(empty, /## Dedupe accuracy\n\nno replay data\n\nn = 0/);
  assert.match(empty, /Source: baseline keyword guess/);
  assert.match(empty, /\| server \| testing \| 15 \| 3 \|/);
  assert.match(empty, /overall 20% \(3 of 15\)/);
  assert.deepEqual(empty.match(/^## .*/gm), SECTIONS);
  const noBase = render({ rows: [], labels: {} });
  assert.match(noBase, /## Repeat rate per area and category\n\nno replay data\n\nn = 0/);
});

// --- main: roots, the local-only rule, hand-written tail, dedupe sample ---
const MARK = "<!-- hand-written -->";
const mk = () => mkdtempSync(join(tmpdir(), "verdict-"));
const runDir = (root) => join(root, ".harness", "replay", "run");
function fixtureRoot(root, { findings = true } = {}) {
  const d = runDir(root);
  mkdirSync(d, { recursive: true });
  const rs = ["none", "facts", "facts+corrections"].map((a) => row("S1", 1, "failed", a, out(["a"], [], a === "facts" ? ["brand new"] : [])));
  writeFileSync(join(d, "results.jsonl"), rs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (findings) writeFileSync(join(d, "new-findings.md"), "- [x] yes \u2014 S1 r1 facts: brand new\n");
  const mem = join(d, "memory", "i-S1", ".harness", "memory", "corrections", "testing");
  mkdirSync(mem, { recursive: true });
  // Evidence is the note's distinct links, so it never outnumbers count (shared/corrections.ts).
  for (const [slug, count, ev] of [["flaky", 2, ["seen one", "seen two"]], ["once", 1, ["seen one"]]]) {
    writeFileSync(join(mem, `${slug}.md`), `---\ntype: correction\nstatus: active\ncategory: testing\narea: server\ncount: ${count}\nevidence:\n${ev.map((e) => `  - ${e}\n`).join("")}---\nbody\n`);
  }
}
const quiet = () => { const lines = []; return { lines, log: (l) => lines.push(l) }; };

test("main: only the repo root writes the committed file; another root stays under its own run dir", () => {
  const repo = mk(), other = mk(), outFile = join(mk(), "verdict.md");
  fixtureRoot(repo);
  fixtureRoot(other);
  const q = quiet();
  main(["--root", other, "--root", repo], { out: outFile, repoRoot: repo, log: q.log });
  const committed = readFileSync(outFile, "utf8");
  assert.match(committed, /n = 1 rounds replayed/);
  assert.ok(existsSync(join(runDir(other), "verdict.md")));
  assert.ok(!existsSync(join(runDir(repo), "verdict.md")));
  assert.ok(q.lines.every((l) => /^wrote /.test(l)), "stdout is only `wrote <path>` lines");
  const outFile2 = join(mk(), "verdict.md");
  const q2 = quiet();
  main(["--root", other], { out: outFile2, repoRoot: repo, log: q2.log });
  assert.ok(!existsSync(outFile2), "a non-repo root never touches the committed path");
  assert.deepEqual(q2.lines, [`wrote ${join(runDir(other), "verdict.md")}`]);
});

test("main: no --root means the repo root; hand-written tail survives reruns; new file gets a placeholder", () => {
  const repo = mk(), outFile = join(mk(), "verdict.md");
  fixtureRoot(repo);
  main([], { out: outFile, repoRoot: repo, log: () => {} });
  const first = readFileSync(outFile, "utf8");
  assert.ok(first.endsWith(`${MARK}\n## Recommendation\n\nTo be written.\n`));
  const tail = `${MARK}\n## Recommendation\n\nShip facts. Edited by hand.\n\nSecond paragraph.\n`;
  writeFileSync(outFile, first.slice(0, first.indexOf(MARK)) + tail);
  main([], { out: outFile, repoRoot: repo, log: () => {} });
  assert.equal(readFileSync(outFile, "utf8").slice(readFileSync(outFile, "utf8").indexOf(MARK)), tail);
  const other = mk();
  fixtureRoot(other);
  main(["--root", other], { out: outFile, repoRoot: repo, log: () => {} });
  const p = join(runDir(other), "verdict.md");
  const edited = readFileSync(p, "utf8").replace("To be written.", "Local note.");
  writeFileSync(p, edited);
  main(["--root", other], { out: outFile, repoRoot: repo, log: () => {} });
  assert.match(readFileSync(p, "utf8"), /Local note\./);
});

test("main: uses labels, merged per-story memory and dedupe labels from the run dir", () => {
  const repo = mk(), outFile = join(mk(), "verdict.md");
  fixtureRoot(repo);
  writeFileSync(join(runDir(repo), "dedupe-sample.md"), "- [x] yes \u2014 corrections/testing/flaky: seen one | seen two\n- [ ] yes / no \u2014 corrections/testing/once: x\n");
  main([], { out: outFile, repoRoot: repo, log: () => {} });
  const text = readFileSync(outFile, "utf8");
  assert.match(text, /\| facts \| 1 failed, 0 control \| 1 \| 0 \| 1 \| 0 \| 0 \|/, "label yes counted as valid new");
  assert.match(text, /Source: replay memory/);
  assert.match(text, /n = 1 sampled pairs; 1 marked as true duplicates \(100%\)/);
});

test("main: --dedupe-sample writes up to 30 seeded checklist lines and no verdict; lines parse back", () => {
  const repo = mk(), outFile = join(mk(), "verdict.md");
  fixtureRoot(repo);
  const q = quiet();
  main(["--root", repo, "--dedupe-sample"], { out: outFile, repoRoot: repo, log: q.log });
  assert.ok(!existsSync(outFile));
  assert.ok(!existsSync(join(runDir(repo), "verdict.md")));
  const text = readFileSync(join(runDir(repo), "dedupe-sample.md"), "utf8");
  const items = text.split("\n").filter((l) => l.startsWith("- [ ] yes / no \u2014 "));
  assert.deepEqual(items, ["- [ ] yes / no \u2014 corrections/testing/flaky: seen one | seen two"]);
  assert.deepEqual(parseDedupeLabels(items[0].replace("[ ]", "[x]").replace("yes / no", "yes")), { "corrections/testing/flaky": "yes" });
  assert.deepEqual(q.lines, [`wrote ${join(runDir(repo), "dedupe-sample.md")}`]);
});

test("main: a missing run dir renders the no-data verdict without crashing", () => {
  const repo = mk(), outFile = join(mk(), "verdict.md");
  main(["--root", repo], { out: outFile, repoRoot: repo, log: () => {} });
  const text = readFileSync(outFile, "utf8");
  assert.match(text, /## Task success\n\nno replay data/);
  assert.match(text, /Source: baseline keyword guess/);
  assert.match(text, /overall 20% \(3 of 15\)/);
});

test("main: --dedupe-sample keeps a file the human has already labelled", () => {
  const repo = mk(), outFile = join(mk(), "verdict.md");
  fixtureRoot(repo);
  const file = join(runDir(repo), "dedupe-sample.md");
  const labelled = "# Dedupe sample\n\n- [x] yes \u2014 corrections/testing/flaky: seen one | seen two\n";
  writeFileSync(file, labelled);
  const q = quiet();
  main(["--root", repo, "--dedupe-sample"], { out: outFile, repoRoot: repo, log: q.log });
  assert.equal(readFileSync(file, "utf8"), labelled);
  assert.deepEqual(q.lines, [`kept ${file} (already labelled)`]);
  writeFileSync(file, "- [ ] yes / no \u2014 corrections/testing/flaky: x\n");
  main(["--root", repo, "--dedupe-sample"], { out: outFile, repoRoot: repo, log: () => {} });
  assert.match(readFileSync(file, "utf8"), /seen one \| seen two/, "an unlabelled file is regenerated");
});

test("main: --dedupe-sample keeps a file labelled the way its own instruction says (`- [ ] yes — <id>`)", () => {
  const repo = mk(), outFile = join(mk(), "verdict.md");
  fixtureRoot(repo);
  const file = join(runDir(repo), "dedupe-sample.md");
  const labelled = "# Dedupe sample\n\n- [ ] yes \u2014 corrections/testing/flaky: seen one | seen two\n";
  writeFileSync(file, labelled);
  main(["--root", repo, "--dedupe-sample"], { out: outFile, repoRoot: repo, log: () => {} });
  assert.equal(readFileSync(file, "utf8"), labelled);
});

test("main: overlapping cumulative snapshots are not counted again per story", () => {
  const repo = mk(), outFile = join(mk(), "verdict.md");
  fixtureRoot(repo);
  for (const story of ["i-S2", "i-S3"]) {
    const dir = join(runDir(repo), "memory", story, ".harness", "memory", "corrections", "testing");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "flaky.md"), "---\ntype: correction\nstatus: active\ncategory: testing\narea: server\ncount: 2\nevidence:\n  - seen one\n  - seen two\n---\nbody\n");
  }
  main(["--root", repo, "--dedupe-sample"], { out: outFile, repoRoot: repo, log: () => {} });
  const sample = readFileSync(join(runDir(repo), "dedupe-sample.md"), "utf8");
  assert.match(sample, /flaky: seen one \| seen two\n/, "evidence is not repeated");
  main([], { out: outFile, repoRoot: repo, log: () => {} });
  assert.match(readFileSync(outFile, "utf8"), /overall 33% \(1 of 3\)/, "flaky 2 + once 1 = 1 repeat in 3, not 3 stories' worth added up");
});

test("main: count covers evidence that only the union of snapshots holds", () => {
  const repo = mk(), outFile = join(mk(), "verdict.md");
  fixtureRoot(repo);
  // Each snapshot leaves out its own story, so S2 and S3 each see a different two of the three observations.
  for (const [story, ev] of [["i-S2", ["seen one", "seen three"]], ["i-S3", ["seen one", "seen two"]]]) {
    const dir = join(runDir(repo), "memory", story, ".harness", "memory", "corrections", "testing");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "flaky.md"), `---\ntype: correction\nstatus: active\ncategory: testing\narea: server\ncount: 2\nevidence:\n${ev.map((e) => `  - ${e}\n`).join("")}---\nbody\n`);
  }
  main([], { out: outFile, repoRoot: repo, log: () => {} });
  assert.match(readFileSync(outFile, "utf8"), /overall 50% \(2 of 4\)/, "flaky 3 + once 1 = 2 repeats in 4");
});

test("render: the repeat definition follows the source", () => {
  const base = render({ rows: [], labels: {}, baseline });
  assert.match(base, /\(area, category\) was seen in an earlier story/);
  assert.doesNotMatch(base, /same correction/);
  const real = render({ rows: [], labels: {}, memory, baseline });
  assert.match(real, /after the first of the same correction/);
});

test("decisions and render: arm verdicts are provisional under d1's minimum, plain at it", () => {
  const under = decisions({ rows, labels, memory: { notes: [] }, baseline });
  assert.ok(under.includes("facts: provisional, does not ship"));
  assert.ok(!under.includes("facts: does not ship"));
  assert.match(render({ rows, labels, baseline }), /\*\*does not ship\*\* \(provisional\)/);
  const bad = roundsOf(20, 20).map((r) => (r.arm === "facts" ? { ...r, outcome: out([], ["a"]) } : r));
  assert.ok(decisions({ rows: bad, labels: {}, baseline }).includes("facts: does not ship"));
  assert.doesNotMatch(render({ rows: bad, labels: {}, baseline }), /\(provisional\)/);
});
