import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_PHASES, type PipelineConfig } from "../shared/pipeline";
import { repoPipelineConfig } from "./repo-pipeline";

const host: PipelineConfig = { enabled: true, phases: DEFAULT_PHASES, reviewRounds: 3, maxFixes: 3, closeOnMerge: true, sources: [] };

test("reads the repo's pipeline file from the worktree", () => {
  const cwd = mkdtempSync(join(tmpdir(), "repo-pipeline-"));
  assert.equal(repoPipelineConfig(host, cwd), host);
  assert.equal(repoPipelineConfig(host, null), host);
  mkdirSync(join(cwd, ".orchestrator"));
  writeFileSync(join(cwd, ".orchestrator", "pipeline.json"), JSON.stringify({ maxFixes: 1 }));
  assert.equal(repoPipelineConfig(host, cwd).maxFixes, 1);
  writeFileSync(join(cwd, ".orchestrator", "pipeline.json"), "{broken");
  assert.equal(repoPipelineConfig(host, cwd).maxFixes, 3);
});

test("loadPhaseConfig uses the phase's profile, else the fallback", async () => {
  const { loadPhaseConfig } = await import("./agent-runner");
  const fallback = { provider: "claude", modeId: "auto" };
  const paseo = {
    config: { get: async () => ({ daemon: { agentProfiles: [{ id: "p1", name: "fast", provider: "claude", model: "haiku" }] } }) },
  } as never;
  assert.deepEqual(await loadPhaseConfig(paseo, undefined, fallback), fallback);
  assert.deepEqual(await loadPhaseConfig(paseo, "fast", fallback), { provider: "claude/haiku" });
  assert.deepEqual(await loadPhaseConfig(paseo, "missing", fallback), fallback);
});
