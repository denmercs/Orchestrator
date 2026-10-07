import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readStories, setFrontmatter } from "./harness-layout";
import { readIssueStatuses } from "./jira";
import { PLAN_MD } from "./plan-render";

// Status → plan, one way. Cards in stages / track-b carry `epic:` and `story:` lines; each card's
// `status:` line is set from where its story lives, and table rows naming the same id get their
// "Jira" / "Status" column set too:
// - a local story id (S1) takes the status in that phase's stories/ file;
// - a Jira key takes the Jira status (refreshPlanFromJira). Jira itself is never changed here.
// The two never touch the same card: a card's key is its story id, else its epic.

const KEY = /\b[A-Z][A-Z0-9_]+-\d+\b/g;
const JOIN = /^(\s*(?:[-*]\s*)?(?:\*\*)?(epic|story|status)(?:\*\*)?\s*:\s*)(.*)$/i;

type Issue = { status: string; summary: string };

function refreshCards(lines: string[], issues: Map<string, Issue>) {
  const out: string[] = [];
  let changed = 0;
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (!lines[i].startsWith("### ")) continue;
    // The card's join lines sit directly under its heading (blank lines allowed).
    const meta: { key: string; status: number | null; last: number } = { key: "", status: null, last: out.length - 1 };
    let epic = "";
    let story = "";
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) {
        out.push(line);
        continue;
      }
      const hit = JOIN.exec(line);
      if (!hit) break;
      const field = hit[2].toLowerCase();
      if (field === "epic") epic = hit[3].trim();
      if (field === "story") story = hit[3].trim();
      out.push(line);
      if (field === "status") meta.status = out.length - 1;
      meta.last = out.length - 1;
    }
    i = j - 1;
    meta.key = story || epic;
    const issue = meta.key ? issues.get(meta.key) : undefined;
    if (!issue) continue;
    if (meta.status !== null) {
      const hit = JOIN.exec(out[meta.status]);
      if (hit && hit[3].trim() !== issue.status) {
        out[meta.status] = `${hit[1]}${issue.status}`;
        changed++;
      }
    } else {
      const indent = /^(\s*(?:[-*]\s*)?)/.exec(out[meta.last])?.[1] ?? "";
      out.splice(meta.last + 1, 0, `${indent}status: ${issue.status}`);
      changed++;
    }
  }
  return { lines: out, changed };
}

const word = (id: string) => new RegExp(`(^|[^A-Za-z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9-])`);

// The issue a table row is about: a Jira key in it, else (only in rows with no Jira key) the local
// id that appears first, so "S2 … | depends on S1" follows S2.
function rowKey(text: string, issues: Map<string, Issue>) {
  const jira = text.match(KEY)?.[0];
  if (jira) return issues.get(jira);
  let first: { at: number; issue: Issue } | null = null;
  for (const [id, issue] of issues) {
    const at = hasKey(id) ? -1 : text.search(word(id));
    if (at >= 0 && (!first || at < first.at)) first = { at, issue };
  }
  return first?.issue;
}

function refreshTables(lines: string[], issues: Map<string, Issue>) {
  let changed = 0;
  let column = -1;
  const cells = (line: string) => line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|");
  const out = lines.map((line, i) => {
    if (!line.trim().startsWith("|")) {
      column = -1;
      return line;
    }
    if (i + 1 < lines.length && /^\s*\|?\s*:?-/.test(lines[i + 1])) {
      column = cells(line).findIndex((cell) => /^\s*(jira|status)\s*$/i.test(cell));
      return line;
    }
    if (column < 0 || /^\s*\|?\s*:?-/.test(line)) return line;
    const row = cells(line);
    const issue = rowKey(row.filter((_, index) => index !== column).join("|"), issues);
    if (!issue || row[column]?.trim() === issue.status) return line;
    row[column] = ` ${issue.status} `;
    changed++;
    return `|${row.join("|")}|`;
  });
  return { lines: out, changed };
}


// Refreshes a phase's architecture.md from Jira. No keys means nothing to do (and no Jira call).
const hasKey = (text: string) => new RegExp(KEY.source).test(text);

// True when some card's join lines name a Jira key, so a Jira refresh has something to read.
export function planNamesJira(md: string) {
  return md.split("\n").some((line) => {
    const hit = JOIN.exec(line);
    return Boolean(hit && hit[2].toLowerCase() !== "status" && hasKey(hit[3]));
  });
}

// Story files → plan. Cheap and offline, so the board runs it on every poll; writes only on change.
export function syncPlanFromStories(epicDir: string) {
  const file = join(epicDir, PLAN_MD);
  if (!existsSync(file)) return 0;
  const stories = new Map(
    readStories(epicDir)
      .filter((story) => !hasKey(story.id))
      .map((story) => [story.id, { status: story.status, summary: story.title }]),
  );
  if (stories.size === 0) return 0;
  const md = readFileSync(file, "utf8");
  const cards = refreshCards(md.split("\n"), stories);
  const tables = refreshTables(cards.lines, stories);
  const next = tables.lines.join("\n");
  if (next !== md) writeFileSync(file, next, "utf8");
  return cards.changed + tables.changed;
}

export async function refreshPlanFromJira(epicDir: string) {
  const file = join(epicDir, PLAN_MD);
  if (!existsSync(file)) return { ok: true, error: null, keys: 0, changed: 0, missing: [] as string[] };
  try {
    const md = readFileSync(file, "utf8");
    // Keys come only from card join lines, so text like "UTF-8" is never sent to Jira.
    const keys = [
      ...new Set(
        md.split("\n").flatMap((line) => {
          const hit = JOIN.exec(line);
          return hit && hit[2].toLowerCase() !== "status" ? (hit[3].match(KEY) ?? []) : [];
        }),
      ),
    ];
    if (keys.length === 0) return { ok: true, error: null, keys: 0, changed: 0, missing: [] as string[] };
    const found = await readIssueStatuses(keys);
    const issues = new Map([...found].map(([key, issue]) => [key, { status: issue.status, summary: issue.summary }]));
    const site = [...found.values()][0]?.url.replace(/\/browse\/.*$/, "") ?? "";
    const cards = refreshCards(md.split("\n"), issues);
    const tables = refreshTables(cards.lines, issues);
    const today = new Date().toISOString().slice(0, 10);
    const next = setFrontmatter(tables.lines.join("\n"), { jira_refreshed: today, ...(site ? { jira_site: site } : {}) });
    if (next !== md) writeFileSync(file, next, "utf8");
    return {
      ok: true,
      error: null,
      keys: keys.length,
      changed: cards.changed + tables.changed,
      missing: keys.filter((key) => !found.has(key)),
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: message.replace(/Basic\s+\S+/gi, "Basic [redacted]"), keys: 0, changed: 0, missing: [] as string[] };
  }
}
