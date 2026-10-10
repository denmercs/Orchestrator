import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PrStatus } from "./pr-checks";
import { mergeBlocker, mergeStoryPr, readyToMerge, reviewSummary, type MergeView } from "./voice-merge";

const state = (findings: string) => `# S3 — Add voice merge\n\n## Status\nreview-done\n\n## Review findings\n${findings}\n## Preview\nnone\n`;

test("the review summary says the purpose, rounds, fixed, open and follow-up findings, and CI fixes", () => {
  const summary = reviewSummary({
    state: state("- fixed: a.ts:1 — x — y\n- fixed: b.ts:2 — x — y\n- c.ts:3 — needs a decision — ask\n- follow-up: split the module\n"),
    prBody: "## Purpose\n\nMerge green PRs by voice.\n\n## Changes Made\n- x\n",
    failedRounds: 1,
    fixAttempts: 2,
  });
  assert.equal(
    summary,
    "Purpose: Merge green PRs by voice. Review passed after 2 rounds. 2 findings fixed. " +
      "Still open: c.ts:3 — needs a decision — ask. Follow-up: split the module. CI needed 2 fixes.",
  );
});

test("a clean review says so, and a story with no worktree has no review on record", () => {
  assert.equal(
    reviewSummary({ state: state(""), prBody: "Purpose: Faster merges.", failedRounds: 0, fixAttempts: 0 }),
    "Purpose: Faster merges. Review passed on the first round. No findings.",
  );
  assert.equal(reviewSummary({ state: "", prBody: "", failedRounds: 0, fixAttempts: 1 }), "No review on record.");
});

test("only open story PRs with green CI are ready to merge, with their review", (t) => {
  const root = mkdtempSync(join(tmpdir(), "voice-merge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stories = join(root, ".harness", "initiatives", "voice", "phases", "1-merge", "stories");
  const worktree = join(root, "wt");
  mkdirSync(stories, { recursive: true });
  mkdirSync(join(worktree, ".harness"), { recursive: true });
  writeFileSync(join(worktree, ".harness", "state.md"), state("- fixed: a.ts:1 — x — y\n"));
  writeFileSync(join(worktree, ".harness", "pr-body.md"), "## Purpose\nMerge by voice.\n");
  const story = (file: string, meta: string) => writeFileSync(join(stories, file), `---\n${meta}\n---\n\n# body\n`);
  story("01-a.md", `id: S1\ntitle: Ready one\nstatus: pr-open\nci: green\npr: 95\nworktree: ${worktree}\nreview_rounds: 1`);
  story("02-b.md", "id: S2\ntitle: Still running\nstatus: pr-open\nci: pending\npr: 96");
  story("03-c.md", "id: S3\ntitle: Done\nstatus: merged\nci: green\npr: 97");
  story("04-d.md", "id: S4\ntitle: No worktree\nstatus: pr-open\nci: green\npr: 98");
  assert.deepEqual(readyToMerge([root]), [
    {
      id: `merge:${root}:voice:S1:95`,
      storyId: "S1",
      title: "Ready one",
      pr: 95,
      cwd: worktree,
      review: "Purpose: Merge by voice. Review passed after 2 rounds. 1 finding fixed.",
    },
    { id: `merge:${root}:voice:S4:98`, storyId: "S4", title: "No worktree", pr: 98, cwd: root, review: "No review on record." },
  ]);
});

const status = (over: Partial<PrStatus> = {}): PrStatus => ({ state: "green", number: 95, url: "u", headSha: "abc", failing: [], ...over });
const view = (over: Partial<MergeView> = {}): MergeView => ({ isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: "abc", ...over });

test("a PR merges only when GitHub says it is green, conflict-free, clean and unchanged", () => {
  assert.equal(mergeBlocker(status(), view()), null);
  assert.equal(mergeBlocker(status(), view({ mergeStateStatus: "HAS_HOOKS" })), null);
  assert.equal(mergeBlocker(null, view()), "couldn't be checked with GitHub");
  assert.equal(mergeBlocker(status({ state: "pending" }), view()), "still has checks running");
  assert.equal(
    mergeBlocker(status({ state: "failing", failing: [{ name: "CI / test", url: "", runId: null }] }), view()),
    "has a failing check: CI / test",
  );
  assert.equal(mergeBlocker(status({ state: "merged" }), view()), "is already merged");
  assert.equal(mergeBlocker(status(), view({ headRefOid: "def" })), "changed while it was being checked");
  assert.equal(mergeBlocker(status(), view({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })), "has conflicts with its base branch");
  assert.match(mergeBlocker(status(), view({ mergeable: "UNKNOWN" })) ?? "", /still being checked/);
  assert.equal(mergeBlocker(status(), view({ mergeStateStatus: "BEHIND" })), "is behind its base branch");
  assert.match(mergeBlocker(status(), view({ mergeStateStatus: "BLOCKED" })) ?? "", /branch rule/);
  assert.equal(mergeBlocker(status(), view({ isDraft: true })), "is a draft");
  assert.equal(mergeBlocker(status(), view({ mergeStateStatus: "UNSTABLE" })), "can't merge yet: unstable");
});

const item = { id: "m1", storyId: "S1", title: "T", pr: 95, cwd: "/wt", review: "" };

test("merging pins the merge to the head GitHub just checked", async () => {
  const calls: string[][] = [];
  const result = await mergeStoryPr(item, {
    status: async () => status(),
    gh: async (args) => {
      calls.push(args);
      return args[1] === "view" ? JSON.stringify(view()) : "";
    },
  });
  assert.deepEqual(result, { merged: true, said: "Merged PR 95." });
  assert.deepEqual(calls[1], ["pr", "merge", "95", "--merge", "--match-head-commit", "abc"]);
});

test("a blocked or failed merge is not merged and says why", async () => {
  const calls: string[][] = [];
  const blocked = await mergeStoryPr(item, {
    status: async () => status(),
    gh: async (args) => {
      calls.push(args);
      return JSON.stringify(view({ mergeable: "CONFLICTING" }));
    },
  });
  assert.deepEqual(blocked, { merged: false, said: "PR 95 has conflicts with its base branch. Not merged." });
  assert.equal(calls.length, 1);
  const failed = await mergeStoryPr(item, {
    status: async () => status(),
    gh: async (args) => {
      if (args[1] === "view") return JSON.stringify(view());
      throw Object.assign(new Error("Command failed"), { stderr: "Head branch was modified.\nmore" });
    },
  });
  assert.deepEqual(failed, { merged: false, said: "PR 95 did not merge: Head branch was modified." });
});
