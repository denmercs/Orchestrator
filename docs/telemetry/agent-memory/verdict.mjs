// Offline replay verdict: renders docs/telemetry/agent-memory/verdict.md. Never imported by server/, client/ or shared/.
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ARMS } from "../../../shared/replay.ts";
import { noteId, readMemory } from "../../../shared/memory.ts";

// d1's minimum sample: complete failed and control rounds, per arm.
const MIN_ROUNDS = 20;
const cell = (s) => String(s).replace(/\|/g, "\\|");

const roundKey = (r) => `${r.initiative}|${r.story}|${r.round}`;

// A round is compared only when all three arms have a row with an outcome and none errored or stopped.
// Error, stopped and no-outcome rows (the judge gave no matches) come back in leftOut with a reason; their whole round is excluded for every arm.
export function completeRounds(rows) {
  const bad = rows.filter((r) => r.error || r.stopped || !r.outcome);
  const badRounds = new Set(bad.map(roundKey));
  const byRound = new Map();
  for (const r of rows) {
    if (!r.outcome || r.error || r.stopped || badRounds.has(roundKey(r))) continue;
    byRound.set(roundKey(r), [...(byRound.get(roundKey(r)) ?? []), r]);
  }
  const complete = rows.filter((r) => {
    const mine = byRound.get(roundKey(r));
    return mine && r.outcome && !r.error && !r.stopped && ARMS.every((a) => mine.some((m) => m.arm === a));
  });
  const leftOut = bad.map((r) => ({ story: r.story, round: r.round, arm: r.arm, reason: r.error ? `error: ${r.error}` : r.stopped ? `stopped: ${r.stopped}` : "no outcome" }));
  return { complete, leftOut };
}

const sum = (rows, f) => rows.reduce((s, r) => s + f(r), 0);
export const labelKey = (r, finding) => `${r.story}|${r.round}|${r.arm}|${finding}`;

// new-findings.md lines: `- [x] yes — S3 r2 facts: <finding>`. Untouched `yes / no` lines are omitted.
export function parseLabels(text) {
  const labels = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^- \[[ xX]\] (yes|no) — (\S+) r(\d+) (none|facts\+corrections|facts): (.*)$/);
    if (m) labels[labelKey({ story: m[2], round: Number(m[3]), arm: m[4] }, m[5])] = m[1];
  }
  return labels;
}

// rows: ResultRow[]; labels: { "<story>|<round>|<arm>|<finding>": "yes" | "no" }.
// Per arm: n failed / control rounds, caught, missed, new findings by label, and whether the arm does not ship.
export const meetsMinimum = (arms) => arms.every((a) => a.nFailed >= MIN_ROUNDS && a.nControl >= MIN_ROUNDS);

export function successByArm(rows, labels = {}) {
  const ok = completeRounds(rows).complete;
  const tally = (arm, keep = () => true) => {
    const mine = ok.filter((r) => r.arm === arm && keep(r));
    const news = mine.flatMap((r) => r.outcome.new.map((f) => labels[labelKey(r, f)]));
    return {
      mine,
      caught: sum(mine, (r) => r.outcome.caught.length),
      missed: sum(mine, (r) => r.outcome.notCaught.length),
      validNew: news.filter((l) => l === "yes").length,
      wrongNew: news.filter((l) => l === "no").length,
      unlabelled: news.filter((l) => l !== "yes" && l !== "no").length,
    };
  };
  return ARMS.map((arm) => {
    const t = tally(arm);
    const failed = t.mine.filter((r) => r.kind === "failed");
    const failedRounds = new Set(failed.map(roundKey));
    const allRounds = new Set(t.mine.map(roundKey));
    const catchBase = tally("none", (r) => r.kind === "failed" && failedRounds.has(roundKey(r)));
    const wrongBase = tally("none", (r) => allRounds.has(roundKey(r)));
    const doesNotShip = arm !== "none" && (t.caught < catchBase.caught || t.wrongNew > wrongBase.wrongNew);
    return {
      arm,
      nFailed: failed.length,
      nControl: t.mine.length - failed.length,
      caught: t.caught,
      missed: t.missed,
      validNew: t.validNew,
      wrongNew: t.wrongNew,
      unlabelled: t.unlabelled,
      doesNotShip,
    };
  });
}

const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const stat = (xs) => {
  const v = xs.filter((x) => x != null);
  return { n: v.length, median: median(v), total: v.reduce((a, b) => a + b, 0) };
};
const FIELDS = {
  tokens: (r) => r.tokens?.used,
  cost: (r) => r.tokens?.costUsd,
  reads: (r) => r.explore?.reads,
  files: (r) => r.explore?.files,
  chars: (r) => r.explore?.chars,
};

// Per arm, over complete rounds only: median and total of tokens, cost and explore (null values skipped, n counts the rest),
// and the median of per-round differences against `none` (rounds where either side is null are skipped).
export function tokensByArm(rows) {
  const ok = completeRounds(rows).complete;
  const none = new Map(ok.filter((r) => r.arm === "none").map((r) => [roundKey(r), r]));
  return ARMS.map((arm) => {
    const mine = ok.filter((r) => r.arm === arm);
    const diff = (f) => {
      const d = mine.flatMap((r) => {
        const a = f(r), b = f(none.get(roundKey(r)));
        return a == null || b == null ? [] : [a - b];
      });
      return { n: d.length, median: median(d) };
    };
    return {
      arm,
      tokens: stat(mine.map(FIELDS.tokens)),
      cost: stat(mine.map(FIELDS.cost)),
      explore: { reads: stat(mine.map(FIELDS.reads)), files: stat(mine.map(FIELDS.files)), chars: stat(mine.map(FIELDS.chars)) },
      delta: arm === "none" ? null : { tokens: diff(FIELDS.tokens), cost: diff(FIELDS.cost), chars: diff(FIELDS.chars) },
    };
  });
}

const PREAMBLE = [
  "# Memory replay verdict",
  "",
  "Goal: decide from replayed past Reviews whether injecting memory (facts, facts+corrections) helps or hurts, against no memory.",
  "Acceptance: each section states its n; with no replay data it says so instead of showing empty tables.",
  "Notes: generated by `docs/telemetry/agent-memory/verdict.mjs`; do not edit the generated sections.",
  "",
];

export function taskSuccess(data) {
  const out = ["## Task success", ""];
  const { complete: ok, leftOut } = completeRounds(data.rows ?? []);
  const left = leftOut.length
    ? ["Left out of the comparison (the whole round, for every arm):", "", ...leftOut.map((l) => `- ${l.story}, round ${l.round}, ${l.arm}: ${l.reason}`), ""]
    : [];
  if (ok.length === 0) return [...out, "no replay data", "", "n = 0", "", ...left];
  const rounds = new Set(ok.map(roundKey)).size;
  out.push(`n = ${rounds} rounds replayed. New findings are split by the human's yes/no labels.`, "");
  out.push("| Arm | Rounds | Caught | Missed | Valid new | Wrong new | Unlabelled | Verdict |", "|---|---|---:|---:|---:|---:|---:|---|");
  const arms = successByArm(data.rows, data.labels);
  const provisional = meetsMinimum(arms) ? "" : " (provisional)";
  for (const a of arms) {
    out.push(`| ${cell(a.arm)} | ${a.nFailed} failed, ${a.nControl} control | ${a.caught} | ${a.missed} | ${a.validNew} | ${a.wrongNew} | ${a.unlabelled} | ${a.doesNotShip ? `**does not ship**${provisional}` : ""} |`);
  }
  return [...out, "", ...left];
}

const num = (x) => (x == null ? "-" : Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/\.?0+$/, ""));
const signed = (x) => (x == null ? "-" : `${x > 0 ? "+" : ""}${num(x)}`);

export function tokensAndExploration(data) {
  const out = ["## Tokens and exploration", ""];
  const ok = completeRounds(data.rows ?? []).complete;
  if (ok.length === 0) return [...out, "no replay data", "", "n = 0", ""];
  out.push(
    `n = ${new Set(ok.map(roundKey)).size} complete rounds. Deltas are the median per-round difference against \`none\` on the same round; null values are skipped.`,
    "Exploration counts typed calls only (Read, Grep, Glob) until S9 merges.",
    "",
    "| Arm | Tokens median | Tokens total | Cost median | Cost total | Reads median | Reads total | Files median | Files total | Chars median | Chars total | Δ tokens | Δ cost | Δ chars |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const a of tokensByArm(data.rows)) {
    const e = a.explore;
    const d = a.delta;
    out.push(
      `| ${cell(a.arm)} | ${num(a.tokens.median)} | ${num(a.tokens.total)} | ${num(a.cost.median)} | ${num(a.cost.total)} | ${num(e.reads.median)} | ${num(e.reads.total)} | ${num(e.files.median)} | ${num(e.files.total)} | ${num(e.chars.median)} | ${num(e.chars.total)} | ${d ? signed(d.tokens.median) : "-"} | ${d ? signed(d.cost.median) : "-"} | ${d ? signed(d.chars.median) : "-"} |`,
    );
  }
  return [...out, ""];
}

// mulberry32: small seeded PRNG, so the same seed always draws the same sample.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const corrections = (memory) => (memory?.notes ?? []).filter((n) => n.type === "correction");

// Up to n corrections with count >= 2, drawn by a seeded shuffle. Each item is one yes/no checklist line:
// { id, category, area, pair } where pair is the note's evidence entries.
export function dedupeSample(memory, n, seed) {
  const pool = corrections(memory).filter((c) => c.count >= 2);
  const rand = mulberry32(seed);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n).map((c) => ({ id: noteId(c), category: c.category, area: c.area, pair: [...c.evidence] }));
}

// dedupe-sample.md lines: `- [x] yes — <note id>: <pair evidence>` (the evidence part is optional).
// Untouched `yes / no` lines are omitted.
export function parseDedupeLabels(text) {
  const labels = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^- \[[ xX]\] (yes|no) — ([^\s:]+)(?::.*)?$/);
    if (m) labels[m[2]] = m[1];
  }
  return labels;
}

// labels from parseDedupeLabels -> { sampled, duplicates }: pairs the human answered, and those marked "yes".
export function dedupeTally(labels) {
  const v = Object.values(labels ?? {});
  return { sampled: v.length, duplicates: v.filter((l) => l === "yes").length };
}

// Observations = sum of count; repeats = sum of (count - 1). With no corrections, the baseline keyword rows
// ({ area, category, findings, repeats }) stand in and the source says so.
export function correctionRepeats(memory, baselineRows = []) {
  const notes = corrections(memory);
  const from = notes.length
    ? { source: "replay memory", items: notes.map((c) => ({ area: c.area ?? "(none)", category: c.category ?? "(none)", observations: c.count, repeats: c.count - 1 })) }
    : { source: "baseline keyword guess", items: baselineRows.map((r) => ({ area: r.area, category: r.category, observations: r.findings, repeats: r.repeats })) };
  const byKey = new Map();
  for (const i of from.items) {
    const k = `${i.area}\u0000${i.category}`;
    const row = byKey.get(k) ?? { area: i.area, category: i.category, observations: 0, repeats: 0 };
    row.observations += i.observations;
    row.repeats += i.repeats;
    byKey.set(k, row);
  }
  const rows = [...byKey.values()].sort((a, b) => a.area.localeCompare(b.area) || a.category.localeCompare(b.category));
  const observations = sum(rows, (r) => r.observations);
  const repeats = sum(rows, (r) => r.repeats);
  return { source: from.source, rows, observations, repeats, overall: observations ? (repeats / observations) * 100 : null };
}

const REPEAT_LIMIT = 25;

// Fixed rules over facts = { rows, labels, memory, baseline }. Returns lines of text.
export function decisions(facts) {
  const lines = [];
  const arms = successByArm(facts.rows ?? [], facts.labels);
  const none = arms.find((a) => a.arm === "none");
  const nFailed = none.nFailed;
  const nControl = none.nControl;
  const enough = nFailed >= MIN_ROUNDS && nControl >= MIN_ROUNDS;
  if (nFailed + nControl === 0) lines.push("no replay data: arms cannot be decided");
  else for (const a of arms.filter((x) => x.arm !== "none")) lines.push(`${a.arm}: ${enough ? "" : "provisional, "}${a.doesNotShip ? "does not ship" : "ships"}`);
  const n = `n = ${nFailed} failed, ${nControl} control complete rounds`;
  if (enough) lines.push(`sample meets d1's minimum of ${MIN_ROUNDS} failed + ${MIN_ROUNDS} control (${n})`);
  else {
    lines.push(`sample is under d1's minimum of ${MIN_ROUNDS} failed + ${MIN_ROUNDS} control (${n})`);
    lines.push("insufficient data, Phase 2 builds facts only");
  }
  const rep = correctionRepeats(facts.memory, facts.baseline);
  if (rep.overall == null) lines.push("repeat rate unknown: no corrections and no baseline rows");
  else {
    const pct = `${Math.round(rep.overall)}%`;
    if (rep.overall < REPEAT_LIMIT) lines.push(`repeat rate ${pct} < ${REPEAT_LIMIT}%: build only the corrections-to-checks path${rep.source === "baseline keyword guess" ? " (provisional: keyword guess)" : ""}`);
    else lines.push(`repeat rate ${pct} >= ${REPEAT_LIMIT}%: corrections stay in scope`);
  }
  return lines;
}

export function dedupeAccuracy(data) {
  const out = ["## Dedupe accuracy", ""];
  const d = data.dedupe;
  if (!d || d.sampled === 0) return [...out, "no replay data", "", "n = 0", ""];
  return [...out, `n = ${d.sampled} sampled pairs; ${d.duplicates} marked as true duplicates (${Math.round((d.duplicates / d.sampled) * 100)}%)`, ""];
}

export function repeatRate(data) {
  const out = ["## Repeat rate per area and category", ""];
  const r = correctionRepeats(data.memory, data.baseline);
  if (r.observations === 0) return [...out, "no replay data", "", "n = 0", ""];
  const repeat = r.source === "replay memory" ? "an observation after the first of the same correction" : "a finding whose (area, category) was seen in an earlier story";
  return [
    ...out,
    `Source: ${r.source}`,
    `n = ${r.observations} observations; overall ${Math.round(r.overall)}% (${r.repeats} of ${r.observations}). A repeat is ${repeat}.`,
    "",
    "| Area | Category | Observations | Repeats |",
    "|---|---|---:|---:|",
    ...r.rows.map((x) => `| ${cell(x.area)} | ${cell(x.category)} | ${x.observations} | ${x.repeats} |`),
    "",
  ];
}

export function decisionLines(data) {
  return ["## Decisions", "", ...decisions(data).map((l) => `- ${l}`), ""];
}

// data: { rows: ResultRow[], labels: Record<string, "yes" | "no">, memory?: Memory, baseline?: BaselineRow[],
//         dedupe?: { sampled, duplicates } (see dedupeTally) }
export function render(data) {
  return [...PREAMBLE, ...taskSuccess(data), ...tokensAndExploration(data), ...dedupeAccuracy(data), ...repeatRate(data), ...decisionLines(data)].join("\n");
}

// Baseline keyword guess, copied from docs/telemetry/agent-memory/baseline.md ("Repeat rate per area and category"):
// 3 repeats in 15 findings (20%). Used only when the replay memory has no corrections.
const BASELINE = [
  ["(none)", "ci-env", 1, 0],
  ["(none)", "testing", 2, 1],
  ["client", "ci-env", 1, 0],
  ["client", "testing", 1, 0],
  ["client", "types", 1, 0],
  ["client", "uncategorised", 2, 1],
  ["server", "ci-env", 1, 0],
  ["server", "testing", 1, 0],
  ["server", "uncategorised", 1, 0],
  ["shared", "testing", 3, 1],
  ["shared", "uncategorised", 1, 0],
].map(([area, category, findings, repeats]) => ({ area, category, findings, repeats }));

const MARKER = "<!-- hand-written -->";
const PLACEHOLDER = `${MARKER}\n## Recommendation\n\nTo be written.\n`;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runDirOf = (root) => join(root, ".harness", "replay", "run");
const readText = (file) => (existsSync(file) ? readFileSync(file, "utf8") : "");

function readRows(file) {
  const rows = [];
  for (const line of readText(file).split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  return rows;
}

// Corrections from every per-story memory root under run/memory/, merged by note id: counts add, evidence joins.
function readRunMemory(dir) {
  const base = join(dir, "memory");
  const byId = new Map();
  const stories = existsSync(base) ? readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
  for (const s of stories) {
    for (const n of readMemory(join(base, s)).notes) {
      if (n.type !== "correction") continue;
      const id = noteId(n);
      const prev = byId.get(id);
      byId.set(id, prev ? { ...prev, count: prev.count + n.count, evidence: [...prev.evidence, ...n.evidence] } : { ...n, evidence: [...n.evidence] });
    }
  }
  return { notes: [...byId.values()] };
}

const oneLine = (s) => String(s).replace(/\s+/g, " ").trim();

// Everything from the marker to EOF in the existing file survives; a new file gets the placeholder.
function withTail(file, generated) {
  const old = readText(file);
  const at = old.indexOf(MARKER);
  return `${generated.replace(/\n*$/, "\n")}\n${at >= 0 ? old.slice(at) : PLACEHOLDER}`;
}

function write(file, text, log) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  log(`wrote ${file}`);
}

// argv: `--root <dir>` (repeatable; default: this repo) and `--dedupe-sample`.
// Only the repo root's verdict goes to `out` (the committed file); any other root writes solely under its own
// `.harness/replay/run/`, and stdout says nothing but `wrote <path>`.
export function main(argv = [], { out = join(dirname(fileURLToPath(import.meta.url)), "verdict.md"), repoRoot = REPO_ROOT, log = console.log } = {}) {
  const roots = [];
  let sample = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) roots.push(resolve(argv[++i]));
    else if (argv[i] === "--dedupe-sample") sample = true;
  }
  if (roots.length === 0) roots.push(resolve(repoRoot));
  for (const root of roots) {
    const dir = runDirOf(root);
    const memory = readRunMemory(dir);
    if (sample) {
      const file = join(dir, "dedupe-sample.md");
      if (/^- \[[xX]\] (yes|no) —/m.test(readText(file))) {
        log(`kept ${file} (already labelled)`);
        continue;
      }
      const lines = dedupeSample(memory, 30, 1).map((d) => `- [ ] yes / no — ${d.id}: ${d.pair.map(oneLine).join(" | ")}`);
      write(file, ["# Dedupe sample", "", "Replace `yes / no` with `yes` if the pair is a true duplicate, `no` if not.", "", ...lines, ""].join("\n"), log);
      continue;
    }
    const data = {
      rows: readRows(join(dir, "results.jsonl")),
      labels: parseLabels(readText(join(dir, "new-findings.md"))),
      memory,
      baseline: BASELINE,
      dedupe: dedupeTally(parseDedupeLabels(readText(join(dir, "dedupe-sample.md")))),
    };
    const target = root === resolve(repoRoot) ? out : join(dir, "verdict.md");
    write(target, withTail(target, render(data)), log);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
