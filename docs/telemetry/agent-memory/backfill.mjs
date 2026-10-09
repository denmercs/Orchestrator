// Offline backfill helpers. Never imported by server/, client/ or shared/.
import { MARKERS, readSection } from "../../../shared/story-method.ts";

const KNOWN = new Set(Object.values(MARKERS));

// Text a tool call wrote: Write content, Edit new_string, or a Bash command (heredoc).
const written = (block) => {
  const input = block.input ?? {};
  if (block.name === "Write") return input.content;
  if (block.name === "Edit") return input.new_string;
  // Review agents edit state.md from a python heredoc, so the markdown sits in string literals with `\n` escapes.
  if (block.name === "Bash") return typeof input.command === "string" ? input.command.replace(/\\n/g, "\n").replace(/(["'])(##\s)/g, "$1\n$2") : undefined;
  return undefined;
};

// The Status marker and Review findings from the last write that sets each section in state.md.
export function reviewFindings(entries) {
  const texts = [];
  for (const entry of entries) {
    const content = entry?.message?.content;
    if (entry?.type !== "assistant" || !Array.isArray(content)) continue;
    for (const block of content) {
      const text = block.type === "tool_use" ? written(block) : undefined;
      if (typeof text === "string") texts.push(text);
    }
  }
  let marker = null;
  let findings = null;
  for (let i = texts.length - 1; i >= 0 && (marker === null || findings === null); i--) {
    if (marker === null) {
      const first = readSection(texts[i], "Status").split("\n").map((l) => l.replace(/`/g, "").trim()).find(Boolean);
      if (first && KNOWN.has(first)) marker = first;
    }
    if (findings === null && /^##\s+Review findings\s*$/m.test(texts[i])) {
      findings = readSection(texts[i], "Review findings")
        .split("\n")
        .map((l) => /^\s*[-*]\s+(.*\S)\s*$/.exec(l)?.[1])
        .filter(Boolean);
    }
  }
  return { marker, findings: findings ?? [] };
}

const subject = (commit) => String(typeof commit === "string" ? commit : (commit?.messageHeadline ?? commit?.message ?? "")).split("\n")[0].trim();
// The loop's fallback subject is "Fix failing CI checks"; "Sn: Fix CI" is the other known form. "Sn: Fix review findings" never matches.
const isCiFix = (commit) => /^(Fix failing CI checks|S\d+:\s*Fix CI)\b/i.test(subject(commit));

// OutcomeEvent[] for one merged story.
// Rounds: the highest `round` on Review agents; the last round passed (the story merged), so failed = rounds - 1.
// A round missing from findingsByRound still counts, with no findings.
// Fixes: the larger of fix-step agents and CI-fix commits, so one fix seen by both is counted once.
export function storyOutcome({ agents = [], commits = [], findingsByRound = {} }) {
  const rounds = Math.max(0, ...agents.filter((a) => a.step === "review" && Number.isFinite(a.round)).map((a) => a.round));
  const events = [];
  for (let round = 1; round < rounds; round++) {
    events.push({ kind: "review-failed", round, findings: findingsByRound[round] ?? [] });
  }
  const fixes = Math.max(agents.filter((a) => a.step === "fix").length, commits.filter(isCiFix).length);
  for (let attempt = 1; attempt <= fixes; attempt++) events.push({ kind: "fix", attempt, checks: ["(unknown)"] });
  events.push({ kind: "merged" });
  return events;
}

// Area = top folder of the finding's file:line; no file:line (or no folder) -> "(none)".
export function area(finding) {
  const m = /([\w.@-]+(?:\/[\w.@-]+)+):\d+/.exec(finding);
  return m ? m[1].split("/")[0] : "(none)";
}

// Keyword rules onto the nine fixed categories; first hit wins, else "uncategorised".
const CATEGORY_RULES = [
  ["testing", /\b(tests?|testing|coverage|assert\w*|spec|mock\w*)\b/i],
  ["types", /\b(types?|typing|typed|typescript|any|cast|generic|interface)\b/i],
  ["error-handling", /\b(errors?|catch|throw\w*|exception|swallow\w*|reject\w*)\b/i],
  ["boundaries", /\b(boundar\w+|layer|import\w*|coupl\w+)\b/i],
  ["security", /\b(security|secrets?|injection|auth\w*|sanitiz\w+|xss|token)\b/i],
  ["ci-env", /\b(ci|pipeline|workflow|node version|env|environment)\b/i],
  ["performance", /\b(slow|performance|perf|latency|o\(n|cache|memo\w*)\b/i],
  ["scope", /\b(scope|unrelated|out of scope|unrequested)\b/i],
  ["conventions", /\b(convention\w*|naming|style|lint\w*|format\w*)\b/i],
];
export function category(finding) {
  const hit = CATEGORY_RULES.find(([, re]) => re.test(finding));
  return hit ? hit[0] : "uncategorised";
}

// stories: ordered [{ id, findings }]. A repeat = same (area, category) seen in an earlier story.
export function repeatRate(stories) {
  const rows = new Map();
  const seen = new Set();
  for (const story of stories) {
    const here = new Set();
    for (const finding of story.findings) {
      const a = area(finding);
      const c = category(finding);
      const key = `${a}\u0000${c}`;
      const row = rows.get(key) ?? { area: a, category: c, findings: 0, repeats: 0 };
      row.findings++;
      if (seen.has(key)) row.repeats++;
      rows.set(key, row);
      here.add(key);
    }
    for (const k of here) seen.add(k);
  }
  return [...rows.values()];
}
