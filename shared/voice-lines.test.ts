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
  assert.equal(spokenLine(text, true), "Result. All green. First. Second. See docs.");
});

test("spokenLine full caps at 1500 characters on a sentence end", () => {
  const line = spokenLine(Array.from({ length: 200 }, (_, i) => `Sentence number ${i}.`).join(" "), true);
  assert.ok(line.length <= 1500 && line.endsWith("."));
});

test("spokenLine says a file's name, not its path", () => {
  assert.equal(spokenLine("Edited `server/speak-replies.ts:55` and /Users/me/app/index.ts."), "Edited speak-replies.ts and index.ts.");
  assert.equal(spokenLine("Opened ~/.paseo/plugins/orchestrator, see ./a/b.md, (src/x.ts)."), "Opened orchestrator, see b.md, (x.ts).");
  assert.equal(spokenLine("Use yes/no or and/or, see https://github.com/a/b on 10/12/2026."), "Use yes/no or and/or, see https://github.com/a/b on 10/12/2026.");
});
