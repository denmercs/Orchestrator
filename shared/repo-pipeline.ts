import { z } from "zod";
import { PHASE_IDS, REVIEW_MODES, THEN_CHOICES, THEN_VALUES, type Phase, type PipelineConfig, type ReviewMode } from "./pipeline";

// A repo's own Story pipeline: `.orchestrator/pipeline.json` at the repo root, committed with the code.
// It overrides the host's pipeline settings for stories started in that repo. Anything it leaves out
// keeps the host value. Skill sources stay host-wide, so a ref names a source the host has connected.
export const REPO_PIPELINE_FILE = ".orchestrator/pipeline.json";

const skillRef = z.object({ name: z.string(), source: z.string() });

const REPO_PATH_MESSAGE = "must be a path inside the repo (relative, no ..)";
// A relative path that stays inside the repo: no leading /, ~ or drive letter, no .. segment.
function isRepoPath(path: string) {
  return !/^([/\\~]|[A-Za-z]:)/.test(path) && !path.split(/[/\\]/).includes("..");
}

const phaseOverride = z.object({
  label: z.string().optional(),
  runs: skillRef.nullable().optional(),
  extras: z.array(skillRef.extend({ required: z.boolean().optional(), optional: z.boolean().optional() })).optional(),
  then: z.enum(THEN_VALUES).optional(),
  profile: z.string().optional(),
});

export const repoPipelineFile = z.object({
  phases: z.partialRecord(z.enum(PHASE_IDS), phaseOverride).optional(),
  reviewRounds: z.number().int().min(1).max(20).optional(),
  // Fix CI attempts per story PR. 0 turns Fix CI off for this repo; the CI watch then only waits for the merge.
  maxFixes: z.number().int().min(0).max(20).optional(),
  closeOnMerge: z.boolean().optional(),
  // The testing-guidelines skill Implement and Review load (shared/testing-skill.ts). Absent or true uses the
  // plugin's built-in one, a repo-relative path to a Markdown file uses the repo's own, false loads none.
  testingSkill: z.union([z.boolean(), z.string().trim().min(1).refine(isRepoPath, REPO_PATH_MESSAGE)]).optional(),
  // How the loop's Review runs (shared/story-method.ts). Absent or "full" is today's Review. "light" runs only the
  // story's own tests in round 1 (local verification before merge covers lint, type-check, suite and build) and gives
  // rounds 2 and later a short fix check without the peer-review and review-patterns skills.
  reviewMode: z.enum(REVIEW_MODES).optional(),
});
export type RepoPipeline = z.infer<typeof repoPipelineFile>;

// A repo-only setting, like testingSkill: the host has no review mode, so a repo that sets none runs the full one.
export function reviewModeOf(override: RepoPipeline | null): ReviewMode {
  return override?.reviewMode ?? "full";
}

// Parsed file text, or the reason it can't be used. Empty text is no override.
export function parseRepoPipeline(text: string): { override: RepoPipeline | null; error: string | null } {
  if (text.trim() === "") return { override: null, error: null };
  try {
    const parsed = repoPipelineFile.safeParse(JSON.parse(text));
    if (parsed.success) return { override: parsed.data, error: null };
    return { override: null, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  } catch (error) {
    return { override: null, error: error instanceof Error ? error.message : String(error) };
  }
}

// `then` must be a handoff the phase allows (Done only ever merges); a bad one keeps the host's.
export function applyRepoPipeline(config: PipelineConfig, override: RepoPipeline | null): PipelineConfig {
  if (!override) return config;
  const phases: Phase[] = config.phases.map((phase) => {
    const change = override.phases?.[phase.id];
    if (!change) return phase;
    return {
      ...phase,
      label: change.label ?? phase.label,
      runs: change.runs === undefined ? phase.runs : change.runs,
      extras: change.extras ?? phase.extras,
      profile: change.profile ?? phase.profile,
      then: change.then && THEN_CHOICES[phase.id].includes(change.then) ? change.then : phase.then,
    };
  });
  return {
    ...config,
    phases,
    reviewRounds: override.reviewRounds ?? config.reviewRounds,
    maxFixes: override.maxFixes ?? config.maxFixes,
    closeOnMerge: override.closeOnMerge ?? config.closeOnMerge,
  };
}
