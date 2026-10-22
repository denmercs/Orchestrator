import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PipelineConfig, ReviewMode } from "../shared/pipeline";
import { REPO_PIPELINE_FILE, applyRepoPipeline, parseRepoPipeline, reviewModeOf } from "../shared/repo-pipeline";

// The repo's own Fix CI limit from `.orchestrator/pipeline.json`, or null when it sets none (or the file is
// missing or broken). The CI watch uses this first, then the host setting.
export function repoMaxFixes(cwd: string | null): number | null {
  if (!cwd) return null;
  const file = join(cwd, REPO_PIPELINE_FILE);
  if (!existsSync(file)) return null;
  const { override } = parseRepoPipeline(readFileSync(file, "utf8"));
  return override?.maxFixes ?? null;
}

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

// The repo's `"reviewMode"` from `.orchestrator/pipeline.json`: "full" when it sets none, or the file is missing or
// broken, so only a repo that opts in gets the light Review.
export function repoReviewMode(cwd: string | null): ReviewMode {
  if (!cwd) return "full";
  const file = join(cwd, REPO_PIPELINE_FILE);
  if (!existsSync(file)) return "full";
  return reviewModeOf(parseRepoPipeline(readFileSync(file, "utf8")).override);
}
