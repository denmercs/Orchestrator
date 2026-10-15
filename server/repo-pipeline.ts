import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PipelineConfig } from "../shared/pipeline";
import { REPO_PIPELINE_FILE, applyRepoPipeline, parseRepoPipeline } from "../shared/repo-pipeline";

// The host config with the repo's `.orchestrator/pipeline.json` applied. A story's worktree is a checkout
// of the repo, so the committed file is there. A missing or broken file leaves the host config as is.
export function repoPipelineConfig(config: PipelineConfig, cwd: string | null): PipelineConfig {
  if (!cwd) return config;
  const file = join(cwd, REPO_PIPELINE_FILE);
  if (!existsSync(file)) return config;
  const { override, error } = parseRepoPipeline(readFileSync(file, "utf8"));
  if (error) console.warn("orchestrator: ignoring", file, error);
  return applyRepoPipeline(config, override);
}
