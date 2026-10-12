import assert from "node:assert/strict";
import { test } from "node:test";
import { listLine, noSessionLine, pickFirstLine, sentLine, spokenLine, whichLine } from "./voice-lines";

test("numbered lines: the session list, pick-first, did-you-mean and no-match all end in how to answer", () => {
  assert.equal(listLine(["Phase 1 architecture", "Check"]), "One, Phase 1 architecture. Two, Check. Say a number, or switch to and a name.");
  assert.equal(listLine(["a", "b"], 5), "One, a. Two, b. And more. Say a number, or switch to and a name.");
  assert.equal(listLine([]), "No sessions are open.");
  assert.equal(pickFirstLine(["a", "b"]), "Pick a session first. One, a. Two, b. Say a number, or switch to and a name.");
  assert.equal(pickFirstLine([]), "Pick a session first. No sessions are open.");
  assert.equal(whichLine(["S4 Plan", "S6 Plan"]), "Did you mean: one, S4 Plan; two, S6 Plan? Say a number.");
  assert.equal(noSessionLine("billing"), "No session called billing.");
  assert.equal(noSessionLine("billing", ["a"]), "No session called billing. One, a. Say a number, or switch to and a name.");
});

test("lines are whole sentences, and replies are spoken as their first plain paragraph", () => {
  assert.equal(sentLine("docs"), "Sent to docs.");
  assert.equal(spokenLine("```ts\nx\n```\n**Done**, see `a.ts`.\n\nMore."), "Done, see a.ts.");
});

test("spokenLine full reads every paragraph without code, tables or list markers", () => {
  const text = "# Result\n\nAll **green**.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n1. First\n2. Second\n\n```ts\nx\n```\n\nSee [docs](http://x).";
  assert.equal(spokenLine(text, "full"), "Result. All green. First. Second. See docs.");
});

test("spokenLine full caps at 1500 characters on a sentence end", () => {
  const line = spokenLine(Array.from({ length: 200 }, (_, i) => `Sentence number ${i}.`).join(" "), "full");
  assert.ok(line.length <= 1500 && line.endsWith("."));
});

test("spokenLine says a file's name, not its path", () => {
  assert.equal(spokenLine("Edited `server/speak-replies.ts:55` and /Users/me/app/index.ts."), "Edited speak-replies.ts and index.ts.");
  assert.equal(spokenLine("Opened ~/.paseo/plugins/orchestrator, see ./a/b.md, (src/x.ts)."), "Opened orchestrator, see b.md, (x.ts).");
  assert.equal(spokenLine("Use yes/no or and/or, see https://github.com/a/b on 10/12/2026."), "Use yes/no or and/or, see a link on 10/12/2026.");
});

test("spokenLine skips commit hashes but keeps numbers and words", () => {
  assert.equal(spokenLine("Merged at f2a6468616af5d678a0bc578d4240482c8419737 (a446d72), call 5551234567, decade."), "Merged at, call 5551234567, decade.");
});

test("spokenLine says PRs and links briefly, and skips UUIDs", () => {
  assert.equal(spokenLine("Opened https://github.com/denmercs/Orchestrator/pull/137. Id 59084a60-49e3-4eb0-8d2f-fa87bc4a7b99."), "Opened PR 137. Id .");
});

test("spokenLine medium squeezes test counts, files, branches and timings", () => {
  const text = [
    "Pushed fix/speak-script-missing. npm test: 1242 pass, 0 fail. It took 30424 ms.",
    "",
    "Edited a.tsx, b.tsx and c.tsx, plus ./x/y.md.",
  ].join("\n");
  assert.equal(spokenLine(text, "medium"), "Pushed the branch. npm test: all tests passing. It took about 30 seconds. Edited three tsx files, plus y.md.");
  assert.equal(spokenLine("3 tests failing.", "medium"), "3 tests failing.");
  assert.equal(spokenLine("5 pass, 2 failed", "medium"), "2 tests failing.");
});

test("spokenLine medium cuts a long list to three and keeps the ask", () => {
  const items = ["one", "two", "three", "four", "five", "six"].map((x) => `- Item ${x}`).join("\n");
  assert.equal(spokenLine(`Done.\n\n${items}\n\nWhich one?`, "medium"), "Done. Item one. Item two. Item three. And three more. Which one?");
});

test("spokenLine medium stays near 700 characters yet never drops the question", () => {
  const filler = Array.from({ length: 30 }, (_, i) => `Filler paragraph number ${i} is here.`).join("\n\n");
  const line = spokenLine(`Start here.\n\n${filler}\n\nSay one to merge, or two to skip.`, "medium");
  assert.ok(line.startsWith("Start here. Filler paragraph number 0"));
  assert.ok(line.endsWith("Say one to merge, or two to skip."));
  assert.ok(line.length <= 760, String(line.length));
});
