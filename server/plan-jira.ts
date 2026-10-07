import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readIssueStatuses } from "./jira";
import { PLAN_MD } from "./plan-render";

// Jira → Markdown, one way. Cards in stages / track-b carry `epic:` and `story:` lines; each
// card's `status:` line is set to the Jira status of its story (or its epic when it has no
// story). Table rows naming a key get their "Jira" column set the same way. Jira itself is
// never changed from here.

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
    const key = row.filter((_, index) => index !== column).join("|").match(KEY)?.[0];
    const issue = key ? issues.get(key) : undefined;
    if (!issue || row[column]?.trim() === issue.status) return line;
    row[column] = ` ${issue.status} `;
    changed++;
    return `|${row.join("|")}|`;
  });
  return { lines: out, changed };
}

function setFrontmatter(md: string, values: Record<string, string>) {
  const end = md.startsWith("---") ? md.indexOf("\n---", 3) : -1;
  if (end === -1) return md;
  let head = md.slice(0, end);
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}: ${value}`;
    const pattern = new RegExp(`^${key}:.*$`, "m");
    head = pattern.test(head) ? head.replace(pattern, line) : `${head}\n${line}`;
  }
  return head + md.slice(end);
}

// Refreshes a phase's architecture.md from Jira. No keys means nothing to do (and no Jira call).
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
