import assert from "node:assert/strict";
import { test } from "node:test";
import { appendOutcome, readOutcome, type OutcomeEvent } from "./story-outcome";

const story = "---\nid: S2\ntitle: Keep outcome\nstatus: todo\n---\n\n## Goal\n\nKeep it.\n";
const round1: OutcomeEvent = { kind: "review-failed", round: 1, findings: ["server/x.ts:12 — wrong — fix", "* shared/y.ts:3 — bad — fix"] };

test("review-failed adds the round with its findings and bumps review_rounds", () => {
  const text = appendOutcome(story, round1);
  assert.match(text, /^review_rounds: 1$/m);
  assert.match(text, /## Outcome\n\n### Review round 1\n- server\/x\.ts:12 — wrong — fix\n- shared\/y\.ts:3 — bad — fix\n$/);
  assert.deepEqual(readOutcome(text).entries, [
    { title: "Review round 1", lines: ["- server/x.ts:12 — wrong — fix", "- shared/y.ts:3 — bad — fix"] },
  ]);
  assert.equal(readOutcome(text).reviewRounds, 1);
});

test("repeating a review round changes nothing; round 2 adds to the same section", () => {
  const once = appendOutcome(story, round1);
  assert.equal(appendOutcome(once, round1), once);
  const twice = appendOutcome(once, { kind: "review-failed", round: 2, findings: [] });
  assert.match(twice, /^review_rounds: 2$/m);
  assert.deepEqual(readOutcome(twice).entries[1], { title: "Review round 2", lines: ["- (no findings written)"] });
  assert.equal(twice.match(/^## Outcome$/gm)?.length, 1);
});

test("fix records the attempt and unions failed_checks", () => {
  let text = appendOutcome(story, { kind: "fix", attempt: 1, checks: ["test", "typecheck"] });
  text = appendOutcome(text, { kind: "fix", attempt: 2, checks: ["test", "lint"] });
  assert.equal(appendOutcome(text, { kind: "fix", attempt: 2, checks: ["test"] }), text);
  assert.match(text, /### CI fix attempt 1\n- failing: test, typecheck\n/);
  assert.match(text, /^fix_attempts: 2$/m);
  assert.match(text, /^failed_checks: test, typecheck, lint$/m);
  assert.deepEqual(readOutcome(text).failedChecks, ["test", "typecheck", "lint"]);
});

test("blocked records the reason and skips a repeat of the last one", () => {
  const text = appendOutcome(story, { kind: "blocked", reason: "CI still failing" });
  assert.equal(appendOutcome(text, { kind: "blocked", reason: "CI still failing" }), text);
  const other = appendOutcome(text, { kind: "blocked", reason: "Review limit" });
  assert.deepEqual(readOutcome(other).entries.map((entry) => entry.lines[0]), ["- CI still failing", "- Review limit"]);
});

test("merged counts rounds and fix attempts once", () => {
  let text = appendOutcome(story, round1);
  text = appendOutcome(text, { kind: "fix", attempt: 1, checks: ["test"] });
  text = appendOutcome(text, { kind: "merged" });
  assert.equal(appendOutcome(text, { kind: "merged" }), text);
  assert.deepEqual(readOutcome(text).entries.at(-1), { title: "Merged", lines: ["- 2 review rounds, 1 CI fix attempt"] });
  assert.match(appendOutcome(story, { kind: "merged" }), /- 1 review round, 0 CI fix attempts/);
});

test("a section followed by another section keeps its place", () => {
  const text = appendOutcome(`${story}\n## Outcome\n\n### Merged\n- x\n\n## Later\n\nz\n`, { kind: "blocked", reason: "r" });
  assert.match(text, /### Blocked\n- r\n\n## Later\n\nz\n$/);
});

test("no-change records Nothing to ship once", () => {
  const text = appendOutcome(story, { kind: "no-change" });
  assert.match(text, /### Nothing to ship\n- The branch had no commits over its base/);
  assert.equal(appendOutcome(text, { kind: "no-change" }), text);
});
