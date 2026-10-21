import assert from "node:assert/strict";
import { test } from "node:test";
import { pipelineSettings } from "./pipeline";
import { applyRepoPipeline, parseRepoPipeline } from "./repo-pipeline";
import { defaultTree, validateTree } from "./loop-tree";

const config = () => pipelineSettings.schema.parse({});

test("defaultTree passes validateTree", () => {
  const tree = defaultTree(config());
  assert.deepEqual(validateTree(tree), []);
  assert.deepEqual(tree.phases.map((p) => p.id), ["plan", "diagnose", "implement", "review", "pr", "fix"]);
});

test("defaultTree takes skills and profile from the config, through the repo override", () => {
  const override = parseRepoPipeline(
    JSON.stringify({
      reviewRounds: 2,
      maxFixes: 5,
      phases: {
        plan: { runs: { name: "my-plan", source: "team" }, profile: "deep" },
        implement: { extras: [{ name: "tdd-extra", source: "team", required: true }], profile: "fast" },
        review: { runs: null, profile: "careful" },
      },
    }),
  ).override;
  const tree = defaultTree(applyRepoPipeline(config(), override));
  const byId = Object.fromEntries(tree.phases.map((p) => [p.id, p]));
  // Diagnose reads the plan phase, fix reads implement, pr reads done.
  assert.deepEqual(byId.plan.runs, { name: "my-plan", source: "team" });
  assert.deepEqual(byId.diagnose.runs, { name: "my-plan", source: "team" });
  assert.equal(byId.diagnose.profile, "deep");
  assert.deepEqual(byId.implement.extras, [{ name: "tdd-extra", source: "team", required: true }]);
  assert.deepEqual(byId.fix.extras, byId.implement.extras);
  assert.equal(byId.fix.profile, "fast");
  assert.equal(byId.review.profile, "careful");
  assert.equal(byId.pr.runs, null);
  assert.equal("profile" in byId.pr, false);
});

test("defaultTree leaves retries out: the repo file's reviewRounds and maxFixes stay the only copy", () => {
  const tree = defaultTree({ ...config(), reviewRounds: 2, maxFixes: 5 });
  assert.equal(tree.phases.some((p) => "retries" in p), false);
  const withRetries = edited((ps) => (phaseOf(ps, "review").retries = 2));
  assert.deepEqual(validateTree(withRetries), []);
});

// Pinned to reconcile in server/initiative-loop.ts: plan-done and diagnose-done both go to Implement,
// implement-done to Review, a failed review back to Implement, review-done to Open PR, a failed PR to Fix CI,
// and Fix CI back to Open PR. A story starts at Plan, a bug at Diagnose.
test("the default tree mirrors the loop's transitions", () => {
  const tree = defaultTree(config());
  const edges = Object.fromEntries(tree.phases.map((p) => [p.id, [p.onPass, p.onFail]]));
  assert.deepEqual(edges, {
    plan: ["implement", null],
    diagnose: ["implement", null],
    implement: ["review", null],
    review: ["pr", "implement"],
    pr: [null, "fix"],
    fix: ["pr", null],
  });
  assert.deepEqual(tree.start, { story: "plan", bug: "diagnose" });
});

test("validateTree checks the start entries and the pass path from each", () => {
  const dead = validateTree(edited((ps) => (phaseOf(ps, "diagnose").onPass = null)));
  assert.ok(dead.some((e) => /"diagnose"/.test(e) && /open-pr/.test(e)), dead.join("\n"));
  const unknown = validateTree({ ...edited(() => undefined), start: { story: "plan", bug: "ghost" } });
  assert.ok(unknown.some((e) => /bug/.test(e) && /"ghost"/.test(e)), unknown.join("\n"));
  const missing = validateTree({ phases: edited(() => undefined).phases });
  assert.ok(missing.some((e) => /start/.test(e)), missing.join("\n"));
  const half = validateTree({ ...edited(() => undefined), start: { story: "plan" } });
  assert.ok(half.some((e) => /start\.bug/.test(e)), half.join("\n"));
});

test("validateTree refuses unknown keys, such as the repo file's limits", () => {
  const top = validateTree({ ...edited(() => undefined), maxFixes: 3 });
  assert.ok(top.some((e) => /maxFixes/.test(e)), top.join("\n"));
  const inPhase = validateTree(edited((ps) => (phaseOf(ps, "fix").maxFixes = 3)));
  assert.ok(inPhase.some((e) => /"fix"/.test(e) && /maxFixes/.test(e)), inPhase.join("\n"));
});

function edited(change: (phases: Record<string, unknown>[]) => void) {
  const phases: Record<string, unknown>[] = structuredClone(defaultTree(config()).phases);
  change(phases);
  return { start: { story: "plan", bug: "diagnose" }, phases };
}
const phaseOf = (phases: Record<string, unknown>[], id: string) => {
  const found = phases.find((p) => p.id === id);
  assert.ok(found);
  return found;
};

test("validateTree refuses a tree whose pass path never opens a PR, naming where it stops", () => {
  const errors = validateTree(edited((ps) => (phaseOf(ps, "review").onPass = null)));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"review"/);
  assert.match(errors[0], /open-pr/);
  const noPr = validateTree(edited((ps) => (phaseOf(ps, "pr").kind = "custom")));
  assert.ok(noPr.some((e) => /open-pr/.test(e)));
});

test("validateTree refuses a cycle made only of onPass edges, naming its phases", () => {
  const errors = validateTree(edited((ps) => (phaseOf(ps, "review").onPass = "plan")));
  assert.ok(errors.some((e) => /"plan"/.test(e) && /"review"/.test(e) && /onPass/.test(e)), errors.join("\n"));
  // The default's review -> implement and pr -> fix -> pr loops each carry an onFail edge, so they pass.
  assert.deepEqual(validateTree(defaultTree(config())), []);
});

test("validateTree refuses duplicate ids, an unknown kind and an edge to a missing phase", () => {
  const dup = validateTree(edited((ps) => (phaseOf(ps, "fix").id = "plan")));
  assert.ok(dup.some((e) => /duplicate/i.test(e) && /"plan"/.test(e)), dup.join("\n"));
  const kind = validateTree(edited((ps) => (phaseOf(ps, "diagnose").kind = "audit")));
  assert.ok(kind.some((e) => /"diagnose"/.test(e) && /kind/.test(e)), kind.join("\n"));
  const edge = validateTree(edited((ps) => (phaseOf(ps, "review").onFail = "nowhere")));
  assert.ok(edge.some((e) => /"review"/.test(e) && /"nowhere"/.test(e)), edge.join("\n"));
  assert.ok(validateTree({ phases: [] }).length > 0);
  assert.ok(validateTree("nope").length > 0);
  const id = validateTree(edited((ps) => (phaseOf(ps, "fix").id = "Fix CI")));
  assert.ok(id.some((e) => /"Fix CI"/.test(e)), id.join("\n"));
});
