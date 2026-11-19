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
