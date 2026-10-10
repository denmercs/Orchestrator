// One-off backfill of merged_at on merged story files. Never imported by server/, client/ or shared/.
// Dry run by default; `--write` writes.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loopAgents } from "../s11/load.mjs";
import { ISO_TIME, storyFiles } from "./report.mjs";

// Adds `merged_at: <iso>` as the last frontmatter line; null if the frontmatter already has one. Only the file top is read.
export function withMergedAt(text, iso) {
  const m = /^---\n([\s\S]*?\n)?---(?=\n|$)/.exec(text);
  if (!m) return null;
  const body = m[1] ?? "";
  if (/^merged_at:/m.test(body)) return null;
  const close = m[0].length - 3;
  return `${text.slice(0, close)}merged_at: ${iso}\n${text.slice(close)}`;
}

// Latest transcript `timestamp` across all of a story's agents (an array of entry arrays), as the original string; null if none.
export function agentClosedAt(entriesByAgent) {
  let best = null;
  let bestMs = -Infinity;
  for (const entries of entriesByAgent) {
    for (const e of entries) {
      const ms = typeof e?.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
      if (ms > bestMs) {
        bestMs = ms;
        best = e.timestamp;
      }
    }
  }
  return best;
}

// Date for a story: its merged PR (by `pr:` number, then by branch), else the agent time, else nulls. A value that is not a zoned ISO time counts as absent.
export function pickMergedAt(fm, prs, agentAt) {
  const pr = prs.find((p) => String(p.number) === fm.pr) ?? prs.find((p) => p.headRefName === fm.branch);
  if (pr && ISO_TIME.test(pr.mergedAt ?? "")) return { at: pr.mergedAt, source: `pr #${pr.number}` };
  if (ISO_TIME.test(agentAt ?? "")) return { at: agentAt, source: "agent" };
  return { at: null, source: null };
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"], ...opts });
const readEntries = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

function main() {
  const write = process.argv.includes("--write");
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = resolve(run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: here }).trim(), "..");
  const todo = storyFiles(repo).filter((f) => !("merged_at" in f.fm));
  let prs;
  try {
    prs = JSON.parse(run("gh", ["pr", "list", "--state", "merged", "--limit", "1000", "--json", "number,headRefName,mergedAt"], { cwd: repo }));
  } catch (err) {
    console.error(`gh failed, nothing written: ${err.stderr || err.message}`);
    process.exit(1);
  }
  const agents = loopAgents({ repo, until: "9999" });
  const unresolved = [];
  let written = 0;
  for (const f of todo) {
    const name = `${f.initiative} ${f.fm.id}`;
    const mine = agents.filter((a) => a.initiative === f.initiative && a.story === f.fm.id && a.transcript);
    const { at, source } = pickMergedAt(f.fm, prs, agentClosedAt(mine.map((a) => readEntries(a.transcript))));
    if (!at) { unresolved.push(name); continue; }
    console.log(`${name} → ${at} (${source})`);
    if (!write) continue;
    const next = withMergedAt(readFileSync(f.path, "utf8"), at);
    if (next === null) { console.log(`  skipped, merged_at appeared meanwhile`); continue; }
    writeFileSync(f.path, next);
    written++;
  }
  console.log(`${todo.length - unresolved.length} stories with a date, ${unresolved.length} unresolved${write ? `, ${written} files written` : " (dry run)"}`);
  for (const name of unresolved) console.log(`unresolved: ${name}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
