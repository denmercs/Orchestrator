import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PHASES, type PipelineConfig } from "./pipeline";
import { applyRepoPipeline, parseRepoPipeline } from "./repo-pipeline";

const host: PipelineConfig = {
  enabled: true,
  phases: DEFAULT_PHASES,
  reviewRounds: 3,
  maxFixes: 3,
  closeOnMerge: true,
  sources: [],
};

test("no override keeps the host config", () => {
  assert.equal(applyRepoPipeline(host, null), host);
});

test("a repo overrides one phase and the limits, the rest stays", () => {
  const { override, error } = parseRepoPipeline(
    JSON.stringify({
      phases: { plan: { then: "auto" }, review: { extras: [{ name: "security-review", source: "installed" }] } },
      reviewRounds: 5,
    }),
  );
  assert.equal(error, null);
  const merged = applyRepoPipeline(host, override);
  assert.equal(merged.phases.find((p) => p.id === "plan")?.then, "auto");
  assert.deepEqual(merged.phases.find((p) => p.id === "review")?.extras, [{ name: "security-review", source: "installed" }]);
  assert.equal(merged.phases.find((p) => p.id === "implement")?.then, "auto");
  assert.equal(merged.reviewRounds, 5);
  assert.equal(merged.maxFixes, 3);
});

test("a handoff the phase does not allow keeps the host's", () => {
  const { override } = parseRepoPipeline(JSON.stringify({ phases: { done: { then: "auto" } } }));
  assert.equal(applyRepoPipeline(host, override).phases.find((p) => p.id === "done")?.then, "merge");
});

test("bad JSON or a bad shape gives a reason and no override", () => {
  assert.notEqual(parseRepoPipeline("{nope").error, null);
  assert.notEqual(parseRepoPipeline(JSON.stringify({ reviewRounds: 99 })).error, null);
  assert.deepEqual(parseRepoPipeline(""), { override: null, error: null });
});

test("a repo sets a profile per phase, so each phase runs its own model", () => {
  const { override } = parseRepoPipeline(
    JSON.stringify({ phases: { plan: { profile: "opus" }, implement: { profile: "sonnet" } } }),
  );
  const merged = applyRepoPipeline(host, override);
  assert.equal(merged.phases.find((p) => p.id === "plan")?.profile, "opus");
  assert.equal(merged.phases.find((p) => p.id === "implement")?.profile, "sonnet");
  assert.equal(merged.phases.find((p) => p.id === "review")?.profile, undefined);
});
