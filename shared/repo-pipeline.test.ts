import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PHASES, type PipelineConfig } from "./pipeline";
import { applyRepoPipeline, parseRepoPipeline, reviewModeOf } from "./repo-pipeline";

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

test("testingSkill takes true, false or a path inside the repo", () => {
  for (const value of [true, false, ".orchestrator/testing.md", "docs/testing/SKILL.md"]) {
    const { override, error } = parseRepoPipeline(JSON.stringify({ testingSkill: value }));
    assert.equal(error, null, String(value));
    assert.equal(override?.testingSkill, value);
  }
});

test("testingSkill rejects paths outside the repo and empty strings", () => {
  for (const value of ["/etc/testing.md", "~/testing.md", "../other/SKILL.md", "docs/../../x.md", "C:\\x.md", "", 3]) {
    const { override, error } = parseRepoPipeline(JSON.stringify({ testingSkill: value }));
    assert.equal(override, null, String(value));
    assert.match(error ?? "", /testingSkill/);
  }
});

test("reviewMode takes full or light and is off by default", () => {
  for (const value of ["full", "light"] as const) {
    const { override, error } = parseRepoPipeline(JSON.stringify({ reviewMode: value }));
    assert.equal(error, null, value);
    assert.equal(reviewModeOf(override), value);
  }
  for (const value of ["lite", true, 1]) {
    const { override, error } = parseRepoPipeline(JSON.stringify({ reviewMode: value }));
    assert.equal(override, null, String(value));
    assert.match(error ?? "", /^reviewMode: /, String(value));
  }
  assert.equal(reviewModeOf(null), "full");
  assert.equal(reviewModeOf(parseRepoPipeline(JSON.stringify({ reviewRounds: 3 })).override), "full");
  // A repo-only setting: it doesn't change the merged host config.
  const { override } = parseRepoPipeline(JSON.stringify({ reviewMode: "light" }));
  assert.deepEqual(applyRepoPipeline(host, override), { ...host, phases: host.phases });
});
