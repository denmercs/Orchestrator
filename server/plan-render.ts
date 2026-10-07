import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A phase's architecture.md is the plan; architecture.html next to it is the derived view for
// people (dark page, Mermaid diagrams, cards for decisions and stages). Never hand-edit the HTML;
// it is rewritten whenever the Markdown is newer.
//
// The Markdown is split into `## <id>` sections (ids below). Inside decisions, stages and
// track-b, `### <id> — <title>` starts a card; leading `epic:`, `story:`, `status:` lines on a
// card are its tracker join, kept current by server/plan-status.ts.

export const PLAN_MD = "architecture.md";
export const PLAN_HTML = "architecture.html";

const SECTIONS: Record<string, string> = {
  job: "Job",
  phase: "Phase we are at",
  "finish-line": "Start → finish",
  locks: "At a glance",
  scope: "Scope",
  current: "Current",
  target: "Target",
  decisions: "Decisions",
  stages: "Stages",
  "track-b": "Second track",
  nongoals: "Non-goals",
};
const NAV: Record<string, string> = { "finish-line": "Start → finish", phase: "Phase", "track-b": "Track B" };
const CARD_SECTIONS = new Set(["decisions", "stages", "track-b"]);
const REQUIRED = ["job", "current", "target", "decisions", "stages"];
const CARD_META = /^(?:[-*]\s*)?(?:\*\*)?(epic|story|status|title|jira)(?:\*\*)?\s*:\s*(.+)$/i;

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function parseFrontmatter(md: string) {
  const text = md.replace(/^﻿/, "");
  const end = text.startsWith("---") ? text.indexOf("\n---", 3) : -1;
  if (end === -1) return { meta: {} as Record<string, string>, body: text };
  const meta: Record<string, string> = {};
  for (const line of text.slice(3, end).split("\n")) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (m) meta[m[1]] = m[2].replace(/\s+#.*$/, "").replace(/^(["'])(.*)\1$/, "$2");
  }
  return { meta, body: text.slice(end + 4).replace(/^\n/, "") };
}

export function splitSections(body: string) {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current) sections.set(current, buf.join("\n").trim());
    buf = [];
  };
  for (const line of body.split("\n")) {
    const m = /^##\s+([a-z0-9_-]+)\s*$/i.exec(line);
    if (m) {
      flush();
      current = m[1].toLowerCase();
    } else buf.push(line);
  }
  flush();
  return sections;
}

const safeHref = (href: string) => (/^(https?:|#|\.{0,2}\/|[\w-]+\.)/i.test(href) ? href : "#");

function inline(text: string) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, href: string) => `<a href="${safeHref(href)}">${label}</a>`);
}

function tone(status: string, section: string) {
  const s = status.toLowerCase();
  if (/done|closed|merged|resolved|released|agreed/.test(s)) return "emerald";
  if (/block|open|park|hold/.test(s)) return "amber";
  if (section === "track-b") return "violet";
  return /progress|review|current|now/.test(s) ? "sky" : "zinc";
}

const BADGE: Record<string, string> = {
  emerald: "bg-emerald-900/60 text-emerald-200",
  amber: "bg-amber-900/60 text-amber-200",
  sky: "bg-sky-900/60 text-sky-200",
  violet: "bg-violet-900/60 text-violet-200",
  zinc: "bg-zinc-800 text-zinc-300",
};
const BORDER: Record<string, string> = {
  emerald: "border-emerald-700/60",
  amber: "border-amber-700/60",
  sky: "border-sky-700/60",
  violet: "border-violet-700/60",
  zinc: "border-zinc-700",
};

function card(section: string, heading: string, lines: string[], site: string) {
  const m = /^###\s+(\S+?)(?::)?\s*(?:—\s*(.*))?$/.exec(heading);
  const id = (m?.[1] ?? "item").toLowerCase();
  let title = (m?.[2] ?? m?.[1] ?? "").trim();
  const meta: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const hit = CARD_META.exec(line);
    if (!hit) break;
    meta[hit[1].toLowerCase()] = hit[2].trim();
  }
  if (meta.title) title = meta.title;
  // Decisions carry their state in the heading: "(open)" or "(resolved: …)".
  const state = /\((open|resolved[^)]*)\)\s*$/i.exec(title);
  if (state) title = title.slice(0, state.index).trim();
  const status = meta.status ?? state?.[1] ?? "";
  const color = tone(status || (section === "track-b" ? "track" : ""), section);
  const key = meta.story || meta.epic || meta.jira || "";
  // Only Jira keys link to Jira; a local story id (S1) is shown as is.
  const link = key
    ? site && /^[A-Z][A-Z0-9_]+-\d+$/.test(key)
      ? `<a class="font-mono text-xs" href="${escapeHtml(`${site}/browse/${key}`)}">${escapeHtml(key)}</a>`
      : `<span class="font-mono text-xs">${escapeHtml(key)}</span>`
    : "";
  const epic = meta.story && meta.epic ? `<span class="text-xs text-zinc-500">in ${escapeHtml(meta.epic)}</span>` : "";
  const badge = status ? `<span class="rounded px-2 py-0.5 text-xs uppercase ${BADGE[color]}">${escapeHtml(status)}</span>` : "";
  return `<article id="${escapeHtml(id)}" class="rounded-lg border ${BORDER[color]} bg-zinc-900/40 px-4 py-3 space-y-2">
<div class="flex flex-wrap items-center gap-2"><span class="font-mono text-xs text-zinc-500">${escapeHtml(m?.[1] ?? "")}</span><strong>${inline(title)}</strong>${link}${epic}${badge}</div>
${block(lines.slice(i).join("\n"), section, site, false)}
</article>`;
}

function block(md: string, section: string, site: string, cards: boolean): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  const starts = (line: string) =>
    /^```|^#{1,4}\s|^\s*[-*]\s+|^\s*\d+\.\s+|^> /.test(line) || (line.includes("|") && line.trim().startsWith("|"));
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push(
        fence[1].toLowerCase() === "mermaid"
          ? `<pre class="mermaid">${escapeHtml(body.join("\n"))}</pre>`
          : `<pre class="overflow-x-auto rounded bg-zinc-900 p-3 text-xs"><code>${escapeHtml(body.join("\n"))}</code></pre>`,
      );
      continue;
    }
    if (cards && line.startsWith("### ")) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("### "); i++) body.push(lines[i]);
      out.push(card(section, line, body, site));
      continue;
    }
    const h = /^(#{1,4})\s+(.+)$/.exec(line);
    if (h) {
      const level = Math.min(h[1].length + 1, 4);
      out.push(`<h${level} class="font-serif text-lg text-zinc-50">${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-/.test(lines[i + 1])) {
      const rows: string[][] = [];
      for (; i < lines.length && lines[i].includes("|"); i++) {
        rows.push(lines[i].replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim()));
      }
      const [head, , ...body] = rows;
      out.push(
        `<table><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr>${body
          .map((row) => {
            const now = row.some((c) => /▶|\bnow\b/i.test(c));
            return `<tr${now ? ' class="bg-sky-950/60"' : ""}>${row.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`;
          })
          .join("")}</table>`,
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const pattern = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
      const items: string[] = [];
      for (; i < lines.length && pattern.test(lines[i]); i++) items.push(lines[i].replace(pattern, ""));
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag} class="${ordered ? "list-decimal" : "list-disc"} pl-5 space-y-1">${items.map((it) => `<li>${inline(it)}</li>`).join("")}</${tag}>`);
      continue;
    }
    if (line.startsWith("> ")) {
      const quote: string[] = [];
      for (; i < lines.length && lines[i].startsWith("> "); i++) quote.push(lines[i].slice(2));
      out.push(`<p class="border-l-4 border-emerald-500 pl-3 text-zinc-200">${inline(quote.join(" "))}</p>`);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i].trim() && !starts(lines[i]) && !(cards && lines[i].startsWith("### ")); i++) para.push(lines[i]);
    if (para.length === 0) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

// Problems a person would notice in the plan: missing sections, diagrams, or unfilled stubs.
export function checkPlan(md: string) {
  const { meta, body } = parseFrontmatter(md);
  const sections = splitSections(body);
  const warnings: string[] = [];
  for (const id of REQUIRED) {
    const text = sections.get(id) ?? "";
    if (!text || /^(…|\.\.\.)$/.test(text)) warnings.push(`## ${id} is empty`);
  }
  for (const id of ["current", "target"]) {
    if (sections.has(id) && !/```mermaid/.test(sections.get(id) ?? "")) warnings.push(`## ${id} has no Mermaid diagram`);
  }
  const keyed = /^(?:[-*]\s*)?(?:epic|story)\s*:/im.test(sections.get("stages") ?? "");
  if (keyed && !sections.has("finish-line")) warnings.push("stages have tracker keys but there is no ## finish-line");
  if (!meta.status) warnings.push("frontmatter has no status");
  return warnings;
}

function renderPlan(md: string, opts: { initiative: string; source: string }) {
  const { meta, body } = parseFrontmatter(md);
  const sections = splitSections(body);
  const site = (meta.jira_site ?? "").replace(/\/+$/, "");
  const ids = [...Object.keys(SECTIONS).filter((id) => sections.has(id)), ...[...sections.keys()].filter((id) => !(id in SECTIONS))];
  const section = (id: string) =>
    `<section id="${escapeHtml(id)}" class="space-y-3"><h2 class="font-serif text-2xl text-zinc-50">${escapeHtml(SECTIONS[id] ?? id)}</h2>
${block(sections.get(id) ?? "", id, site, CARD_SECTIONS.has(id))}
</section>`;
  const parts: string[] = [];
  for (const id of ids) {
    if (id === "target" && sections.has("current")) continue;
    if (id === "current" && sections.has("target")) {
      parts.push(`<div class="grid gap-6 md:grid-cols-2">${section("current")}<div class="rounded-lg border border-emerald-800/60 p-4">${section("target")}</div></div>`);
      continue;
    }
    parts.push(section(id));
  }
  const nav = ids
    .map((id) => `<a href="#${escapeHtml(id)}" class="${id === "finish-line" ? "font-medium text-sky-400" : "hover:text-sky-300"}">${escapeHtml(NAV[id] ?? SECTIONS[id] ?? id)}</a>`)
    .join(" ");
  const phase = meta.phase ? `Phase ${meta.phase}` : "Phase";
  const title = `${phase}${meta.title ? ` — ${meta.title}` : ""}`;
  const status = [
    `Status: ${meta.status || "draft"}`,
    meta.updated ? `Updated ${meta.updated}` : "",
    meta.jira_refreshed ? `Jira refreshed ${meta.jira_refreshed}` : "",
  ].filter(Boolean).join(" · ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)} — architecture</title>
<script src="https://cdn.tailwindcss.com"></script>
<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  mermaid.initialize({ startOnLoad: true, theme: "dark", securityLevel: "strict" });
</script>
<style>
  html { scroll-behavior: smooth; }
  section[id], article[id] { scroll-margin-top: 4rem; }
  a { color: #93c5fd; } a:hover { color: #bfdbfe; }
  code { font-size: 0.85em; color: #e4e4e7; }
  table { border-collapse: collapse; width: 100%; font-size: 0.875rem; }
  th, td { border: 1px solid #27272a; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
  th { background: #18181b; color: #a1a1aa; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }
</style>
</head>
<body class="bg-zinc-950 text-zinc-100 font-sans">
<nav class="sticky top-0 z-20 flex flex-wrap gap-3 border-b border-zinc-800 bg-zinc-950/95 px-4 py-2 text-xs text-zinc-300 backdrop-blur">
<span class="text-zinc-500">${escapeHtml(opts.initiative)}</span> ${nav}
</nav>
<main class="mx-auto max-w-5xl space-y-12 px-6 py-10">
<header class="space-y-1">
<p class="text-xs uppercase tracking-wider text-zinc-500">${escapeHtml(opts.initiative)}</p>
<h1 class="font-serif text-3xl text-zinc-50">${escapeHtml(title)}: architecture</h1>
<p class="text-sm text-zinc-400">${escapeHtml(status)}</p>
</header>
${parts.join("\n")}
<footer class="text-sm text-zinc-500">Plan: ${escapeHtml(opts.source)} · this page is generated from it; edit the Markdown, not this file.</footer>
</main>
</body>
</html>
`;
}

// Rewrites architecture.html when the Markdown is newer (or when forced). Returns the HTML path
// and any warnings, or null when the phase has no plan yet.
export function renderPhasePlan(epicDir: string, opts: { initiative: string; source: string; force?: boolean }) {
  const mdFile = join(epicDir, PLAN_MD);
  if (!existsSync(mdFile)) return null;
  const htmlFile = join(epicDir, PLAN_HTML);
  const md = readFileSync(mdFile, "utf8");
  const stale = !existsSync(htmlFile) || statSync(mdFile).mtimeMs > statSync(htmlFile).mtimeMs;
  if (stale || opts.force) writeFileSync(htmlFile, renderPlan(md, opts), "utf8");
  return { file: htmlFile, warnings: checkPlan(md) };
}
