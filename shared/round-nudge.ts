import { budgetMoney, money } from "./stats-strip";

/** The review round that triggers one human nudge per story (`round_nudged` in frontmatter). */
export const ROUND_NUDGE_AT = 3;

/** Due from review round 3 on until a send reached someone and recorded `round_nudged`. */
export function roundNudgeDue(meta: Record<string, string | undefined>, reviewRound: number): boolean {
  return reviewRound >= ROUND_NUDGE_AT && meta.round_nudged !== String(ROUND_NUDGE_AT);
}

/** The story's spend against its cost cap; `spent` is null when telemetry can't say. */
export type NudgeSpend = { spent: number | null; cap: number };

/** "$4.20 of $5", or undefined when spend is unknown. */
export function roundNudgeDetail(spend?: NudgeSpend): string | undefined {
  return spend && spend.spent !== null ? `${money(spend.spent)} of ${budgetMoney(spend.cap)}` : undefined;
}

export function roundNudgeLine(storyId: string, title?: string | null, spend?: NudgeSpend): string {
  const label = title?.trim() ? `${storyId} (${title.trim()})` : storyId;
  const detail = roundNudgeDetail(spend);
  const spent = detail ? `, ${detail} spent` : "";
  return `${label} has reached review round ${ROUND_NUDGE_AT}${spent}; the cap on rounds and spend is near.`;
}
