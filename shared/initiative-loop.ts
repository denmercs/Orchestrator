import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// The initiative loop: Start on an initiative runs its stories phase by phase, each in its own
// Paseo worktree workspace, through Plan → Implement (one agent running each cycle in a subagent, or
// one agent per cycle with `subagentCycles` off) → Review, then the plugin
// opens the PR and watches CI until you merge. The engine is server/initiative-loop.ts; the step
// prompts are shared/story-method.ts.

export const LOOP_STEPS = ["plan", "implement", "review", "pr", "fix"] as const;
export type LoopStep = (typeof LOOP_STEPS)[number];

export const STEP_LABELS: Record<LoopStep, string> = {
  plan: "Plan",
  implement: "Implement",
  review: "Review",
  pr: "Open PR",
  fix: "Fix CI",
};

// The steps that run an agent and so get a profile of their own (Open PR runs none).
export const PROFILE_STEPS = ["plan", "implement", "review", "fix"] as const;
export type ProfileStep = (typeof PROFILE_STEPS)[number];

// The `kind` label on every loop session; the story drawer lists a story's sessions by it.
export const LOOP_AGENT_KIND = "initiative-loop";

const loopValues = z.object({
  // Stories in flight at once (each in its own worktree).
  parallel: z.number().int().min(1).max(4).default(1),
  // Review → Implement rounds before the story blocks for you.
  reviewRounds: z.number().int().min(1).max(10).default(3),
  // Fix CI attempts per story before it blocks for you.
  maxFixes: z.number().int().min(0).max(10).default(3),
  // Times the loop restarts or nudges a step whose session failed, died or stopped without its
  // marker, before the story blocks for you.
  maxRetries: z.number().int().min(0).max(10).default(2),
  // Agent profile id per step; empty means Auto (an Opus or Sonnet profile, else the runner's).
  profiles: z
    .object({
      plan: z.string().default(""),
      implement: z.string().default(""),
      review: z.string().default(""),
      fix: z.string().default(""),
    })
    .prefault({}),
  // Round-1 Implement with a cycle checklist: one agent that runs each cycle in a subagent, not one
  // agent per cycle.
  subagentCycles: z.boolean().default(true),
});

export type LoopConfig = z.infer<typeof loopValues>;

export const initiativeLoopSettings = defineSettings({
  id: "initiative-loop",
  scope: "host",
  version: 1,
  schema: loopValues,
});

export const DEFAULT_LOOP_CONFIG: LoopConfig = loopValues.parse({});

const loopRef = z.object({ repo: z.string(), initiative: z.string() });

export const startInitiativeLoop = defineRpc({
  name: "orchestration.initiative-loop.start",
  input: loopRef,
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    // Stories that started a Plan agent just now, and what the loop is waiting on otherwise.
    started: z.array(z.object({ story: z.string(), agentId: z.string() })),
    reason: z.string(),
  }),
});

// Stops starting new work. Agents already running keep going; Start again picks up where it left off.
export const stopInitiativeLoop = defineRpc({
  name: "orchestration.initiative-loop.stop",
  input: loopRef,
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});
