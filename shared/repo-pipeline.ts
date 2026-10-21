import { z } from "zod";
import { PHASE_IDS, THEN_CHOICES, THEN_VALUES, type Phase, type PipelineConfig } from "./pipeline";

// A repo's own Story pipeline: `.orchestrator/pipeline.json` at the repo root, committed with the code.
// It overrides the host's pipeline settings for stories started in that repo. Anything it leaves out
// keeps the host value. Skill sources stay host-wide, so a ref names a source the host has connected.
export const REPO_PIPELINE_FILE = ".orchestrator/pipeline.json";

const skillRef = z.object({ name: z.string(), source: z.string() });
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
});
export type RepoPipeline = z.infer<typeof repoPipelineFile>;

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
