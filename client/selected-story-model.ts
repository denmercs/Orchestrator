import { type AgentProfile, profileForStep } from "../shared/agent-profiles";
import type { StoryContext } from "../shared/context";
import { type LoopConfig, type LoopStep, STEP_LABELS } from "../shared/initiative-loop";
import type { EpicStory } from "../shared/orchestration";
import { formatTokens } from "./context-pill-model";

// The loop step behind each stepBar column (Plan, Implement, Review, PR, CI watch). PR runs no
// agent; CI watch runs the Fix CI agent (decision 3).
const BAR_STEPS: (LoopStep | null)[] = ["plan", "implement", "review", null, "fix"];

// The model under each step of the bar: the step's profile's model, else its name; "Auto" when no
// profile resolves; "—" for PR.
export function stepModels(
  loop: Pick<LoopConfig, "profiles">,
  profiles: AgentProfile[],
  runnerId: string,
): string[] {
  return BAR_STEPS.map((step) => {
    if (step === null) return "—";
    const { profile } = profileForStep(loop, step, profiles, runnerId);
    return profile ? profile.model || profile.name : "Auto";
  });
}

export type ContextBar = { key: "system" | "conversation" | "tool" | "used"; width: number };

// The selected story's context block, as text and widths (design lines 205–240).
export type ContextBlock = {
  header: string;
  usedLabel: string;
  // Each segment's width as % of max (of used when max is unknown), to one decimal; one "used" bar
  // without a split.
  bars: ContextBar[];
  warnAt: number | null;
  actAt: number | null;
  actWord: "compact" | "hand off";
  legend: string[];
  compactionNote: string;
  cost: string;
  cap: string;
  burn: string;
  hitsLabel: string;
  turnsLeft: string;
  turnsTone: "amber" | "default";
  policy: string;
};

// 3.8k under 10k, 148k above.
function tokens(n: number): string {
  return n < 10_000 ? `${(n / 1000).toFixed(1)}k` : formatTokens(n);
}

const dollars = (n: number) => `$${n.toFixed(2)}`;

function stepLabel(step: string | null): string {
  if (step && step in STEP_LABELS) return STEP_LABELS[step as LoopStep];
  return step ? step[0].toUpperCase() + step.slice(1) : "Agent";
}

export function contextBlock(ctx: StoryContext, costUsd: number | null, capUsd: number): ContextBlock {
  const step = stepLabel(ctx.step);
  const used = ctx.used ?? 0;
  const whole = ctx.max ?? used;
  const width = (n: number) => (whole > 0 ? Math.min(100, Math.round((n / whole) * 1000) / 10) : 0);
  const { warn, act } = ctx.markers;
  const at = (marker: { tokens: number; percent: number | null }) =>
    marker.percent === null ? tokens(marker.tokens) : `${marker.percent}%`;
  const turns = ctx.turnsToAct;
  return {
    header: `Context · ${step} session ${ctx.session}`,
    usedLabel:
      ctx.used === null ? "—" : ctx.max === null ? tokens(ctx.used) : `${tokens(ctx.used)} / ${tokens(ctx.max)}`,
    bars: ctx.split
      ? [
          { key: "system", width: width(ctx.split.system) },
          { key: "conversation", width: width(ctx.split.conversation) },
          { key: "tool", width: width(ctx.split.tool) },
        ]
      : [{ key: "used", width: width(used) }],
    warnAt: warn.percent,
    actAt: act.percent,
    actWord: act.word,
    legend: ctx.split
      ? [
          `System + skills ${tokens(ctx.split.system)}`,
          `Conversation ${tokens(ctx.split.conversation)}`,
          `Tool output ${tokens(ctx.split.tool)}`,
          "approx.",
        ]
      : [`Used ${tokens(used)}`],
    compactionNote: ctx.compactions > 0 ? `Compacted ${ctx.compactions}× this session` : "",
    cost: costUsd === null ? "—" : dollars(costUsd),
    cap: `cap ${dollars(capUsd)}`,
    burn: ctx.burn === null ? "—" : `~${tokens(ctx.burn)} / turn`,
    hitsLabel: `Hits ${at(act)} in`,
    turnsLeft: turns === null ? "—" : turns === "now" ? "now" : `~${turns} turns`,
    turnsTone: turns === "now" || (typeof turns === "number" && turns < 10) ? "amber" : "default",
    policy: `${step}: warn at ${at(warn)}, ${act.word} at ${at(act)}.`,
  };
}

export type CtaAction =
  | { kind: "agent"; agentId: string }
  | { kind: "pr"; url: string }
  | { kind: "start" }
  | { kind: "details" };

// What the header's stepBar CTA does (decision 5); null hides the button.
export function ctaAction(
  cta: string | null,
  story: Pick<EpicStory, "agent" | "pr">,
  repoUrl: string,
): CtaAction | null {
  switch (cta) {
    case "Open session":
    case "Review plan":
      return story.agent ? { kind: "agent", agentId: story.agent } : null;
    case "Open PR":
    case "Review & merge":
      return story.pr && repoUrl ? { kind: "pr", url: `${repoUrl}/pull/${story.pr}` } : null;
    case "Start agent":
      return { kind: "start" };
    case "View plan":
      return { kind: "details" };
    default:
      return null;
  }
}
