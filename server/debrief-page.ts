import type { DebriefNotes } from "../shared/debrief-notes";
import type { ChangedFile } from "./debrief-git";

// The Debrief page (see CONTEXT.md, "Debrief renderer"): one fixed template, one file, its own CSS,
// no network. The data is embedded as JSON with sorted keys, so the same inputs give the same bytes.

export type DebriefPageData = {
  summary: string | null;
  branch: string;
  base: string;
  sha: string;
  date: string;
  files: ChangedFile[];
  problems: string[];
  notes: DebriefNotes | null;
};

const esc = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, inner]) => [key, sorted(inner)]),
        )
      : value;

const STYLE = `
body { font: 15px/1.5 system-ui, sans-serif; margin: 0; background: #18181b; color: #e4e4e7; }
header, section, nav { max-width: 60rem; margin: 0 auto; padding: 1rem 1.5rem; }
nav a { color: #38bdf8; margin-right: 1rem; }
h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
h2 { font-size: 1.1rem; border-bottom: 1px solid #3f3f46; padding-bottom: .25rem; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; margin: 0; }
dt { color: #a1a1aa; }
code, li.file { font-family: ui-monospace, monospace; }
.status { display: inline-block; width: 1.5rem; color: #a1a1aa; }
.problems li { color: #fbbf24; }
.soon { color: #71717a; font-style: italic; }
button { background: #0369a1; color: #fff; border: 0; border-radius: .375rem; padding: .5rem 1.25rem; font: inherit; cursor: pointer; }
#done-note { margin-left: 1rem; }
`;

const SCRIPT = `
const button = document.getElementById("done");
const note = document.getElementById("done-note");
const board = "Couldn't reach the board. Open this page from the board to press Done.";
button.addEventListener("click", async () => {
  try {
    const response = await fetch("done", { method: "POST" });
    note.textContent = response.ok ? "Done. The plugin is opening the PR." : board;
  } catch {
    note.textContent = board;
  }
});
`;

const soon = (id: string, title: string) =>
  `<section id="${id}"><h2>${title}</h2><p class="soon">Coming soon.</p></section>`;

export function debriefPage(data: DebriefPageData): string {
  const json = JSON.stringify(sorted(data)).replace(/</g, "\\u003c");
  const files = data.files.length
    ? data.files.map((f) => `<li class="file"><span class="status">${esc(f.status)}</span>${esc(f.path)}</li>`).join("\n")
    : `<li class="soon">No changed files.</li>`;
  const problems = data.problems.length
    ? `<ul class="problems">${data.problems.map((p) => `<li>${esc(p)}</li>`).join("\n")}</ul>`
    : `<p class="soon">None.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Debrief: ${esc(data.branch)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>${esc(data.summary ?? "No summary: see problems below.")}</h1>
<dl>
<dt>Branch</dt><dd><code>${esc(data.branch)}</code></dd>
<dt>Base</dt><dd><code>${esc(data.base)}</code></dd>
<dt>Head</dt><dd><code>${esc(data.sha.slice(0, 7))}</code> · ${esc(data.date)}</dd>
</dl>
</header>
<nav><a href="#run">Run</a><a href="#path">Path</a><a href="#expectations">Expectations</a><a href="#drift">Drift</a><a href="#gate">Gate</a></nav>
<section id="files"><h2>Changed files</h2><ul>
${files}
</ul></section>
<section id="problems"><h2>Problems</h2>${problems}</section>
${soon("run", "Run")}
${soon("path", "Path")}
${soon("expectations", "Expectations")}
${soon("drift", "Drift")}
<section id="gate"><h2>Gate</h2><button id="done" type="button">Done</button><span id="done-note"></span></section>
<script type="application/json" id="debrief-data">${json}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
