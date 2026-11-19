import assert from "node:assert/strict";
import { test } from "node:test";
import { debriefPage, type DebriefPageData } from "./debrief-page";

const data: DebriefPageData = {
  summary: "Adds the renderer.",
  branch: "feature/x",
  base: "main",
  sha: "0123456789abcdef0123456789abcdef01234567",
  date: "2026-11-19T10:00:00-06:00",
  files: [
    { path: "server/a.ts", status: "A" },
    { path: "server/b.ts", status: "M" },
  ],
  problems: ["notes[1]: dropped"],
  notes: null,
};

const embedded = (html: string) => {
  const match = /<script type="application\/json" id="debrief-data">([^]*?)<\/script>/.exec(html);
  assert.ok(match);
  return JSON.parse(match[1]!);
};

test("the page shows the header, the changed files and the problems", () => {
  const html = debriefPage(data);
  for (const text of ["Adds the renderer.", "feature/x", "main", "0123456", "2026-11-19T10:00:00-06:00", "server/a.ts", "server/b.ts", "notes[1]: dropped"]) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(!html.replace(/<script[^]*?<\/script>/g, "").includes("0123456789abcdef"), "only the short sha is shown");
});

test("the page has the five section anchors, with coming soon on the first four", () => {
  const html = debriefPage(data);
  for (const id of ["run", "path", "expectations", "drift", "gate"]) {
    assert.ok(html.includes(`id="${id}"`), id);
    assert.ok(html.includes(`href="#${id}"`), `nav ${id}`);
  }
  assert.equal(html.match(/coming soon/gi)?.length, 4);
});

test("the Done button posts to the relative url done and falls back to the board", () => {
  const html = debriefPage(data);
  assert.match(html, /<button[^>]*>\s*Done\s*<\/button>/);
  assert.ok(html.includes('fetch("done", { method: "POST" })'));
  assert.ok(html.includes("Open this page from the board to press Done."));
});

test("the embedded data has sorted keys and survives text that would break out of the script", () => {
  const nasty = { ...data, summary: "</script><script>alert(1)</script>" };
  const html = debriefPage(nasty);
  assert.equal(html.match(/<\/script>/g)?.length, 2, "only the page's own two scripts close");
  assert.ok(!html.includes("<script>alert"), "the text is escaped everywhere");
  assert.equal(embedded(html).summary, nasty.summary);
  assert.deepEqual(Object.keys(embedded(html)), Object.keys(embedded(html)).slice().sort());
});

test("the page stays offline: no urls, no src, no link tags", () => {
  const html = debriefPage(data);
  assert.doesNotMatch(html, /https?:/);
  assert.doesNotMatch(html, /\bsrc=/);
  assert.doesNotMatch(html, /<link/i);
});

const ref = (side: "+" | "-", snippet: string) => ({ file: "client/strip.tsx", side, snippet });
const motion: NonNullable<DebriefPageData["motion"]> = {
  file: "/out/motion.md",
  text: 'Make a 65-second animated explainer.\n\n**Scene 1 (0–8s): Start.** "z 1000" <b>',
  cut: [{ path: "yarn.lock", reason: "generated" }],
  problems: ["scenes[2] (Old): decision cites no added line"],
  motion: {
    title: "T",
    subtitle: "S",
    metaphor: "m",
    scenes: [
      {
        name: "Start",
        visual: "v",
        labels: [],
        beats: [{ caption: "c" }],
        decision: { text: "Raise the strip.", refs: [ref("+", "zIndex: 1000")] },
        instead_of: { text: "A portal.", refs: [ref("-", "<Overlay portal />")] },
        because: null,
      },
    ],
  },
};

test("with no motion brief the page has no Motion brief section", () => {
  const html = debriefPage(data);
  assert.ok(!html.includes('id="motion"'));
  assert.ok(!html.includes('href="#motion"'));
});

test("the Motion brief section shows the text to copy, its path, the cut files and each scene's cited lines", () => {
  const html = debriefPage({ ...data, motion });
  assert.ok(html.includes('id="motion"') && html.includes('href="#motion"'));
  assert.match(html, /<h2>Motion brief<\/h2>/);
  assert.match(html, /<textarea id="motion-text" readonly[^>]*>Make a 65-second animated explainer\.\n\n\*\*Scene 1 \(0–8s\): Start\.\*\* &quot;z 1000&quot; &lt;b&gt;<\/textarea>/);
  assert.match(html, /<button id="copy-motion" type="button">Copy<\/button>/);
  for (const text of ["/out/motion.md", "yarn.lock", "generated", "scenes[2] (Old): decision cites no added line", "Raise the strip.", "zIndex: 1000", "A portal.", "&lt;Overlay portal /&gt;", "None shown in the diff."]) {
    assert.ok(html.includes(text), text);
  }
  assert.equal(html.match(/coming soon/gi)?.length, 4);
  assert.doesNotMatch(html, /https?:|\bsrc=|<link/i);
});

test("the Copy button works from a local file: clipboard API with a select-and-copy fallback", () => {
  const html = debriefPage({ ...data, motion });
  assert.ok(html.includes("navigator.clipboard.writeText"));
  assert.ok(html.includes('document.execCommand("copy")'));
});

test("a motion brief that wasn't written says so and still lists its problems", () => {
  const html = debriefPage({ ...data, motion: { file: null, text: null, cut: [], problems: ["No architectural decision in this diff."], motion: null } });
  assert.ok(html.includes("No motion brief was written."));
  assert.ok(html.includes("No architectural decision in this diff."));
  assert.ok(!html.includes('id="copy-motion"'));
});
