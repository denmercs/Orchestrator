import type { LoopStep } from "./story-method";

/** The review round that triggers one human nudge per story (`round_nudged` in frontmatter). */
export const ROUND_NUDGE_AT = 3;

const NUDGE_STEPS = new Set<LoopStep>(["implement", "review"]);

// `round` is the loop's review round on both steps. Slices use `review_round` so QA failures on `round` don't nudge.
export function shouldRoundNudge(
  step: LoopStep,
  round: number,
  meta: Record<string, string | undefined>,
  factory: boolean,
): boolean {
  if (!NUDGE_STEPS.has(step) || meta.round_nudged === String(ROUND_NUDGE_AT)) return false;
  const reviewRound = factory ? Number(meta.review_round) || 1 : round;
  if (reviewRound !== ROUND_NUDGE_AT) return false;
  if (step === "implement" && !factory && round !== ROUND_NUDGE_AT) return false;
  return true;
}

export function roundNudgeLine(storyId: string, title?: string | null): string {
  const label = title?.trim() ? `${storyId} (${title.trim()})` : storyId;
  return `${label} is on round 3; the cap on rounds and spend is near.`;
}
