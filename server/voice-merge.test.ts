import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrStatus } from "./pr-checks";
import { handleVoiceRequest, createVoiceBridge } from "./voice-bridge";
import { bodySummary, createVoiceMerge, spokenReview, type MergePort, type PrFacts } from "./voice-merge";

const pr: PrFacts = {
  number: 95,
  title: "Merge PRs by voice",
  body: "## Purpose\n\nSay merge it on the phone and the last session's PR merges after a review.\n\n## Changes Made\n- one",
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  reviewDecision: "",
  additions: 120,
  deletions: 4,
  changedFiles: 3,
  headRefOid: "abc123",
};

const green: PrStatus = { state: "green", number: 95, url: "", headSha: "abc123", failing: [] };

function fakePort(overrides: Partial<MergePort> = {}) {
  const merged: [string, number, string][] = [];
  const port: MergePort = {
    lastSession: async () => ({ title: "Story 4", cwd: "/repo" }),
    pr: async () => pr,
    checks: async () => green,
    merge: async (cwd, number, headSha) => {
      merged.push([cwd, number, headSha]);
    },
    ...overrides,
  };
  return { port, merged };
}

test("the summary is the body's first prose line, not a heading", () => {
  assert.equal(bodySummary(pr.body), "Say merge it on the phone and the last session's PR merges after a review.");
  assert.equal(bodySummary(""), "");
});

test("a clean PR is spoken with its summary, size and a go-ahead", () => {
  assert.equal(
    spokenReview(pr, green),
    "PR 95: Merge PRs by voice. Say merge it on the phone and the last session's PR merges after a review. " +
      "3 files, 120 lines added, 4 removed. Checks passed. No conflicts. Looks good. Say confirm to merge, or no.",
  );
});

test("failing checks, conflicts and drafts are named before asking", () => {
  const failing: PrStatus = { ...green, state: "failing", failing: [{ name: "CI / test", url: "", runId: null }] };
  const said = spokenReview({ ...pr, mergeable: "CONFLICTING", isDraft: true }, failing);
  assert.match(said, /I wouldn't merge it yet: it has merge conflicts; checks are failing: CI \/ test; it is still a draft\./);
  assert.match(said, /Say confirm to merge anyway, or no\.$/);
});

test("merge it reviews and listens; confirm merges the reviewed head", async () => {
  const { port, merged } = fakePort();
  const voice = createVoiceMerge(port);
  const review = await voice.command("Just merge it.");
  assert.equal(review.listen, true);
  assert.match(review.said, /^PR 95: /);
  assert.deepEqual(await voice.command("Confirm"), { said: "Merged PR 95.", listen: false });
  assert.deepEqual(merged, [["/repo", 95, "abc123"]]);
});

test("confirm does nothing without a fresh review, and no cancels it", async () => {
  let clock = 0;
  const { port, merged } = fakePort();
  const voice = createVoiceMerge(port, () => clock);
  assert.match((await voice.command("confirm")).said, /nothing waiting/);
  await voice.command("merge it");
  assert.equal((await voice.command("no")).said, "Okay, not merging.");
  assert.match((await voice.command("confirm")).said, /nothing waiting/);
  await voice.command("merge it");
  clock = 3 * 60_000;
  assert.match((await voice.command("confirm")).said, /nothing waiting/);
  assert.equal(merged.length, 0);
});

test("no session or no open PR is said plainly and nothing is armed", async () => {
  const none = createVoiceMerge(fakePort({ lastSession: async () => null }).port);
  assert.match((await none.command("merge it")).said, /No session has finished yet/);
  const { port, merged } = fakePort({ pr: async () => null });
  const noPr = createVoiceMerge(port);
  assert.deepEqual(await noPr.command("merge it"), { said: "Story 4 has no open PR.", listen: false });
  assert.match((await noPr.command("confirm")).said, /nothing waiting/);
  assert.equal(merged.length, 0);
});

test("a failed merge is reported, not thrown", async () => {
  const voice = createVoiceMerge(
    fakePort({
      merge: async () => {
        throw new Error("Head branch was modified");
      },
    }).port,
  );
  await voice.command("merge it");
  assert.deepEqual(await voice.command("confirm"), { said: "GitHub didn't merge PR 95. Check it in the app.", listen: false });
});

test("http command needs the token and a text field", async () => {
  const bridge = createVoiceBridge({ respond: async () => {} });
  const merge = createVoiceMerge(fakePort().port);
  const call = (authorization: string, body: string) =>
    handleVoiceRequest(bridge, "t", { method: "POST", path: "/voice/command", authorization, body }, merge);
  assert.equal((await call("Bearer wrong", JSON.stringify({ text: "merge it" }))).status, 401);
  assert.equal((await call("Bearer t", "{")).status, 400);
  assert.equal((await call("Bearer t", JSON.stringify({}))).status, 400);
  const ok = await call("Bearer t", JSON.stringify({ text: "merge it" }));
  assert.equal(ok.status, 200);
  assert.equal((ok.body as { listen: boolean }).listen, true);
});
