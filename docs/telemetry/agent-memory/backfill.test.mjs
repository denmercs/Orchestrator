// Review findings come from the Review agent's last write of state.md, in any of three forms.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewFindings, storyOutcome, area, category, repeatRate } from "./backfill.mjs";
import { appendOutcome, readOutcome } from "../../../shared/story-outcome.ts";

const use = (name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name, input }] } });
const body = (status, ...items) =>
  `## Plan\nx\n\n## Review findings\n${items.map((i) => `- ${i}`).join("\n")}\n\n## Status\n${status}\n`;
const want = { marker: "review-failed", findings: ["server/a.ts:1 — missing test", "client/b.ts:2 — bad type"] };
const items = ["server/a.ts:1 — missing test", "client/b.ts:2 — bad type"];

test("Write content", () => {
  const entries = [
    use("Write", { file_path: "/r/.harness/state.md", content: body("review-done") }),
    use("Write", { file_path: "/r/.harness/state.md", content: body("review-failed", ...items) }),
  ];
  assert.deepEqual(reviewFindings(entries), want);
});

test("Edit new_string", () => {
  const entries = [use("Edit", { file_path: "/r/.harness/state.md", old_string: "x", new_string: body("review-failed", ...items) })];
  assert.deepEqual(reviewFindings(entries), want);
});

test("Bash heredoc", () => {
  const command = `cat >> .harness/state.md <<'EOF'\n${body("review-failed", ...items)}EOF`;
  assert.deepEqual(reviewFindings([use("Bash", { command })]), want);
});

test("no parseable write", () => {
  assert.deepEqual(reviewFindings([use("Bash", { command: "ls" })]), { marker: null, findings: [] });
});

test("storyOutcome: failed rounds, CI fixes deduped against agents, merged last", () => {
  const agents = [
    { step: "review", round: 1 },
    { step: "review", round: 2 },
    { step: "review", round: 3 },
    { step: "fix", round: null },
    { step: "implement", round: null },
  ];
  const commits = ["S4: Fix review findings", "Fix failing CI checks", "S4: Fix CI", "S4: Add thing"];
  const findingsByRound = { 1: ["server/a.ts:1 — missing test"], 2: ["client/b.ts:2 — bad type"] };
  const events = storyOutcome({ agents, commits, findingsByRound });
  assert.deepEqual(events.map((e) => e.kind), ["review-failed", "review-failed", "fix", "fix", "merged"]);
  assert.deepEqual(events[0], { kind: "review-failed", round: 1, findings: findingsByRound[1] });
  assert.deepEqual(events.filter((e) => e.kind === "fix").map((e) => e.attempt), [1, 2]);
  const text = events.reduce(appendOutcome, "---\nstatus: merged\n---\n\n## Plan\nx\n");
  const out = readOutcome(text);
  assert.equal(out.reviewRounds, 2);
  assert.equal(out.fixAttempts, 2);
});

test("storyOutcome: agent fixes win when they outnumber CI commits; none is just merged", () => {
  const agents = [{ step: "review", round: 1 }, { step: "fix" }, { step: "fix" }];
  assert.equal(storyOutcome({ agents, commits: ["Fix failing CI checks"], findingsByRound: {} }).filter((e) => e.kind === "fix").length, 2);
  assert.deepEqual(storyOutcome({ agents: [], commits: [], findingsByRound: {} }), [{ kind: "merged" }]);
});

test("area: top folder of file:line, else (none)", () => {
  assert.equal(area("server/x.ts:12 — missing test"), "server");
  assert.equal(area("`client/ui/a.tsx:3` — bad"), "client");
  assert.equal(area("shared/y.ts — no line"), "(none)");
  assert.equal(area("something vague, no file"), "(none)");
  assert.equal(area("README.md:4 — typo"), "(none)");
});

test("category: keyword hits onto the nine categories, misses uncategorised", () => {
  assert.equal(category("server/a.ts:1 — missing test for retry"), "testing");
  assert.equal(category("a.ts:1 — unsafe any cast, wrong type"), "types");
  assert.equal(category("a.ts:1 — swallowed error, no catch"), "error-handling");
  assert.equal(category("a.ts:1 — naming does not follow convention"), "conventions");
  assert.equal(category("a.ts:1 — imports across module boundary"), "boundaries");
  assert.equal(category("a.ts:1 — secret leaked, injection risk"), "security");
  assert.equal(category("a.ts:1 — CI fails on node version"), "ci-env");
  assert.equal(category("a.ts:1 — slow O(n^2) loop"), "performance");
  assert.equal(category("a.ts:1 — out of scope change"), "scope");
  assert.equal(category("a.ts:1 — hmm"), "uncategorised");
});

test("repeatRate: a repeat needs the same (area, category) in an EARLIER story", () => {
  const stories = [
    { id: "S1", findings: ["server/a.ts:1 — missing test", "server/b.ts:2 — missing test again"] },
    { id: "S2", findings: ["server/c.ts:3 — missing test", "client/d.ts:4 — missing test"] },
    { id: "S3", findings: ["server/e.ts:5 — missing test"] },
  ];
  const rows = repeatRate(stories);
  const get = (a, c) => rows.find((r) => r.area === a && r.category === c);
  assert.deepEqual(get("server", "testing"), { area: "server", category: "testing", findings: 4, repeats: 2 });
  assert.deepEqual(get("client", "testing"), { area: "client", category: "testing", findings: 1, repeats: 0 });
  assert.equal(rows.length, 2);
});

test("reviewFindings reads a python heredoc whose string literals use \\n escapes", () => {
  const command = "python3 - <<'EOF'\ns=open('.harness/state.md').read()\nf=\"\"\"## Review findings\\n- server/x.ts:1 — a gap\\n\"\"\"\ns=s.replace(\"## Status\\nreview-failed\",\"\")\nEOF";
  const entries = [{ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } }];
  assert.deepEqual(reviewFindings(entries).findings, ["server/x.ts:1 — a gap"]);
});
