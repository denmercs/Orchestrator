// Offline corpus for the memory replay (S7): one row per Review round to replay. Never imported by server/, client/ or shared/.
// Writes .harness/replay/corpus.jsonl in the repo. Reads Claude transcripts and `gh`; run by hand.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loopAgents } from "../s11/load.mjs";
import { reviewFindings, written } from "./backfill.mjs";
import { readOutcome } from "../../../shared/story-outcome.ts";
import { readSection } from "../../../shared/story-method.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const keyOf = (initiative, story) => `${initiative}/${story}`;

// stories: [{ initiative, id, title?, body? }]; `body` is the story file without frontmatter and `## Outcome`. agents: loopAgents() records.
// prCommits: { "initiative/story": [{ oid, committedDate, parent?, parentDate? }] }, oldest first, `parent` and `parentDate` set on the first commit. findingsByRound: { "initiative/story": { [round]: string[] } }.
// plans: { "initiative/story": { plan, cycles } }.
// Failed rows: every Review round before the story's last (it merged, so each earlier round failed).
// Controls: round-1 Reviews of stories that never failed, most recent first; `controls` defaults to the number of failed rows.
export function corpusRows({ stories = [], agents = [], prCommits = {}, findingsByRound = {}, plans = {}, controls } = {}) {
  const reviews = agents.filter((a) => a.step === "review" && Number.isFinite(a.round));
  const build = (story, agent, kind) => {
    const key = keyOf(story.initiative, story.id);
    const commits = prCommits[key] ?? [];
    const head = commits.filter((c) => c.committedDate <= agent.createdAt).pop();
    if (!head) return null;
    return {
      initiative: story.initiative,
      story: story.id,
      title: story.title || story.id,
      body: story.body ?? "",
      round: agent.round,
      kind,
      commit: head.oid,
      base: commits[0].parent ?? null,
      asOf: commits[0].parentDate ?? commits[0].committedDate, // d5: the story's base, not its first commit
      findings: kind === "failed" ? (findingsByRound[key]?.[agent.round] ?? []) : [],
      plan: plans[key]?.plan ?? "",
      cycles: plans[key]?.cycles ?? "",
    };
  };
  const failed = [];
  const firstPass = [];
  for (const story of stories) {
    const mine = reviews.filter((a) => a.initiative === story.initiative && a.story === story.id).sort((a, b) => a.round - b.round);
    const last = mine.length ? mine[mine.length - 1].round : 0;
    for (const agent of mine) {
      if (agent.round < last) failed.push([story, agent]);
      else if (last === 1) firstPass.push([story, agent]);
    }
  }
  const rows = failed.map(([s, a]) => build(s, a, "failed")).filter(Boolean);
  const take = controls ?? rows.length;
  const picked = firstPass
    .sort((a, b) => byText(b[1].createdAt ?? "", a[1].createdAt ?? ""))
    .map(([s, a]) => build(s, a, "control"))
    .filter(Boolean)
    .slice(0, take);
  return [...rows, ...picked];
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"], ...opts });
const readEntries = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const frontmatter = (text) => {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  return Object.fromEntries(block.split("\n").flatMap((l) => { const i = l.indexOf(":"); return i > 0 ? [[l.slice(0, i).trim(), l.slice(i + 1).trim()]] : []; }));
};

function storyFiles(repo) {
  const files = [];
  const base = join(repo, ".harness", "initiatives");
  for (const initiative of readdirSync(base).sort()) {
    const phases = join(base, initiative, "phases");
    let phaseDirs = [];
    try { phaseDirs = readdirSync(phases).sort(); } catch { continue; }
    for (const phase of phaseDirs) {
      const dir = join(phases, phase, "stories");
      let names = [];
      try { names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort(); } catch { continue; }
      for (const n of names) {
        const text = readFileSync(join(dir, n), "utf8");
        const fm = frontmatter(text);
        if (fm.status === "merged") files.push({ initiative, id: fm.id, title: fm.title, body: storyBody(text), text, fm });
      }
    }
  }
  return files;
}

// What the loop hands a Review as the story body: the file without frontmatter, and without `## Outcome` so recorded findings don't leak.
export function storyBody(text) {
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  return body.replace(/^##[ \t]+Outcome[ \t]*\n[\s\S]*?(?=^##[ \t]|(?![\s\S]))/m, "").trim();
}

// `## Outcome` round lines: { [round]: string[] }.
function outcomeFindings(text) {
  const out = {};
  for (const entry of readOutcome(text).entries) {
    const m = /^Review round (\d+)$/.exec(entry.title);
    if (m) out[m[1]] = entry.lines.map((l) => l.replace(/^[-*]\s+/, "")).filter((l) => l !== "(no findings written)");
  }
  return out;
}

// The Plan agent's last write of `## Plan` and of `## Cycles`.
function planSections(entries) {
  const texts = entries.flatMap((e) => (e?.type === "assistant" && Array.isArray(e.message?.content) ? e.message.content : []))
    .flatMap((b) => (b.type === "tool_use" ? [written(b)] : []))
    .filter((t) => typeof t === "string");
  const last = (heading) => {
    for (let i = texts.length - 1; i >= 0; i--) {
      const s = readSection(texts[i], heading).trim();
      if (s) return s;
    }
    return "";
  };
  return { plan: last("Plan"), cycles: last("Cycles") };
}

function main() {
  const repo = resolve(run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: HERE }).trim(), "..");
  const flag = process.argv.indexOf("--controls");
  const controls = flag > 0 ? Number(process.argv[flag + 1]) : undefined;
  if (controls !== undefined && !(Number.isInteger(controls) && controls >= 0)) {
    console.error("--controls takes a whole number");
    process.exit(1);
  }
  const files = storyFiles(repo);
  const all = loopAgents({ repo }).sort((a, b) => byText(a.createdAt ?? "", b.createdAt ?? "") || byText(a.id, b.id));
  const prCommits = {};
  try {
    const prs = JSON.parse(run("gh", ["pr", "list", "--state", "merged", "--limit", "1000", "--json", "number,headRefName"], { cwd: repo }));
    for (const f of files) {
      const pr = prs.find((p) => String(p.number) === f.fm.pr) ?? prs.find((p) => p.headRefName === f.fm.branch);
      if (!pr) continue;
      const commits = (JSON.parse(run("gh", ["pr", "view", String(pr.number), "--json", "commits"], { cwd: repo })).commits ?? [])
        .map((c) => ({ oid: c.oid, committedDate: c.committedDate }));
      if (!commits.length) continue;
      // gh's output has no parent; asOf (d5) is the parent's committer date.
      commits[0].parent = run("git", ["rev-parse", `${commits[0].oid}^`], { cwd: repo }).trim();
      commits[0].parentDate = run("git", ["show", "-s", "--format=%cI", commits[0].parent], { cwd: repo }).trim();
      prCommits[keyOf(f.initiative, f.id)] = commits;
    }
  } catch (err) {
    console.error(`gh or git failed, nothing written: ${err.stderr || err.message}`);
    process.exit(1);
  }

  const findingsByRound = {};
  const plans = {};
  const entriesOf = (a) => (a.transcript ? readEntries(a.transcript) : null);
  for (const f of files) {
    const key = keyOf(f.initiative, f.id);
    const mine = all.filter((a) => a.initiative === f.initiative && a.story === f.id);
    const byRound = outcomeFindings(f.text);
    for (const a of mine.filter((x) => x.step === "review")) {
      if (byRound[a.round]?.length) continue;
      const entries = entriesOf(a);
      if (!entries) continue;
      const found = reviewFindings(entries);
      if (found.marker === "review-failed" || found.findings.length) byRound[a.round] = found.findings;
    }
    findingsByRound[key] = byRound;
    const planAgent = mine.filter((a) => a.step === "plan" && a.transcript).pop();
    if (planAgent) plans[key] = planSections(readEntries(planAgent.transcript));
  }

  const stories = files.map((f) => ({ initiative: f.initiative, id: f.id, title: f.title, body: f.body }));
  const rows = corpusRows({ stories, agents: all, prCommits, findingsByRound, plans, controls });
  const out = join(repo, ".harness", "replay", "corpus.jsonl");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  const failed = rows.filter((r) => r.kind === "failed").length;
  console.log(`corpus.jsonl: ${failed} failed, ${rows.length - failed} control rows → ${out}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
