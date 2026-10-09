import assert from "node:assert/strict";
import { test } from "node:test";
import { ciAction } from "./ci-watch";
import type { PrStatus } from "./pr-checks";

const pr = (state: PrStatus["state"], headSha = "abc"): PrStatus => ({
  state,
  number: 45,
  url: "https://pr/45",
  headSha,
  failing: state === "failing" ? [{ name: "CI / test", url: "https://gh/actions/runs/9/job/1", runId: "9" }] : [],
});
const fresh = { fixedSha: null, attempts: 0 };

test("ciAction records merged and closed PRs", () => {
  assert.deepEqual(ciAction(pr("merged"), fresh, 3), { kind: "merged" });
  assert.deepEqual(ciAction(pr("closed"), fresh, 3), { kind: "closed" });
});

test("ciAction waits on pending, green and no-checks, naming the CI state", () => {
  assert.deepEqual(ciAction(pr("pending"), fresh, 3), { kind: "wait", ci: "pending" });
  assert.deepEqual(ciAction(pr("green"), fresh, 3), { kind: "wait", ci: "green" });
  assert.deepEqual(ciAction(pr("no-checks"), fresh, 3), { kind: "wait", ci: "none" });
});

test("ciAction starts a fix for a failing head it has not tried, counting the attempt", () => {
  assert.deepEqual(ciAction(pr("failing", "abc"), fresh, 3), { kind: "fix", ci: "failing", attempt: 1, headSha: "abc" });
  assert.deepEqual(ciAction(pr("failing", "def"), { fixedSha: "abc", attempts: 1 }, 3), {
    kind: "fix",
    ci: "failing",
    attempt: 2,
    headSha: "def",
  });
});

test("ciAction waits while the fix for this head is still in flight", () => {
  assert.deepEqual(ciAction(pr("failing", "abc"), { fixedSha: "abc", attempts: 1 }, 3), { kind: "wait", ci: "failing" });
});

test("ciAction gives up once a new failure arrives after maxFixes attempts", () => {
  assert.deepEqual(ciAction(pr("failing", "ghi"), { fixedSha: "def", attempts: 3 }, 3), {
    kind: "give-up",
    ci: "failing",
    reason: "CI still failing after 3 fix attempts: CI / test",
  });
  assert.equal(ciAction(pr("failing"), fresh, 0).kind, "give-up");
});
