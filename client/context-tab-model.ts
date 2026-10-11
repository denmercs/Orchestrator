import type { ContextConfig } from "../shared/context";

// Stepping rules for the drawer's Context tab. The schema allows 1–100; the design keeps Warn and Act
// on a 5% grid inside 40–95, with Act at least one step above Warn.
const POLICY_MIN = 40;
const POLICY_MAX = 95;
const POLICY_STEP = 5;

type Thresholds = { warn: number; act: number };

function clampPolicy(value: number) {
  return Math.max(POLICY_MIN, Math.min(POLICY_MAX, value));
}

// `direction` is +1 for the plus button, -1 for the minus button. An off-grid saved value steps from
// where it is and lands in range on the first press.
export function stepWarn({ warn, act }: Thresholds, direction: 1 | -1) {
  const next = clampPolicy(warn + direction * POLICY_STEP);
  return direction > 0 ? Math.min(act - POLICY_STEP, next) : next;
}

export function stepAct({ warn, act }: Thresholds, direction: 1 | -1) {
  const next = clampPolicy(act + direction * POLICY_STEP);
  return direction < 0 ? Math.max(warn + POLICY_STEP, next) : next;
}

const STUCK_MIN = 3;
const STUCK_MAX = 30;

export function stepStuckTurns(turns: number, direction: 1 | -1) {
  return Math.max(STUCK_MIN, Math.min(STUCK_MAX, turns + direction));
}

const CAP_FLOOR = 1;

// Whole-dollar steps, no upper bound.
export function stepCap(usd: number, direction: 1 | -1) {
  return Math.max(CAP_FLOOR, usd + direction);
}

export function capLabel(usd: number) {
  return `$${usd.toFixed(2)}`;
}

export const MODE_LABEL = { compact: "Compact", fresh: "Fresh session" } as const satisfies Record<
  ContextConfig["plan"]["mode"],
  string
>;

// One card per step, in pipeline order. Implement has no note: nothing switches it to a fresh session
// after repeated compactions, so the design's line about that is left out.
export const POLICY_STEPS: { key: "plan" | "implement" | "review"; label: string; note?: string }[] = [
  { key: "plan", label: "Plan" },
  { key: "implement", label: "Implement" },
  {
    key: "review",
    label: "Review",
    note: "Review always starts in a fresh session so findings aren’t biased by Implement history.",
  },
];
