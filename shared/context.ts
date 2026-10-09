import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// The context watch's settings and RPCs (see CONTEXT.md, "Context meter"). The pure meter is
// shared/context-meter.ts; the server side registers these in S2.

const contextValues = z.object({
  // Tokens at which a session's level turns amber, then red.
  amber: z.number().int().min(1).default(100_000),
  red: z.number().int().min(1).default(150_000),
});

export type ContextConfig = z.infer<typeof contextValues>;

export const contextSettings = defineSettings({
  id: "context",
  scope: "host",
  version: 1,
  schema: contextValues,
});

export const CONTEXT_ACTIONS = ["compact", "fresh", "remind", "ignore"] as const;
export type ContextAction = (typeof CONTEXT_ACTIONS)[number];

// A pill action on one session. `agentId` in the output is the new session after `fresh`.
export const contextAct = defineRpc({
  name: "orchestration.context.act",
  input: z.object({ agentId: z.string(), action: z.enum(CONTEXT_ACTIONS) }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    agentId: z.string().nullable(),
  }),
});

export const contextSummary = z.object({
  turns: z.number(),
  sessions: z.number(),
  sessionsOverThreshold: z.number(),
  warnings: z.number(),
  compactions: z.object({ native: z.number(), fresh: z.number(), inferred: z.number() }),
  ignored: z.number(),
  reminded: z.number(),
  // Σ(preTokens − used) over compact rows.
  tokensAvoided: z.number(),
  // Per loop step, over turn rows with a step: turns, Σ used (context tokens, not billed), and the
  // sorted distinct models ("unknown" when a row has none).
  // `explore` (S1) sums each agent's last exploration count for the step: `agents` with a count,
  // `edited` the agents that reached a code edit, `unknown` the agents whose count was lost. Absent
  // when no row of the step carries one.
  byStep: z.record(
    z.string(),
    z.object({
      turns: z.number(),
      tokens: z.number(),
      models: z.array(z.string()),
      explore: z
        .object({
          agents: z.number(),
          reads: z.number(),
          searches: z.number(),
          files: z.number(),
          chars: z.number(),
          edited: z.number(),
          unknown: z.number(),
        })
        .optional(),
    }),
  ),
  // The same totals per "<initiative>/<story>", over turn rows with a story ("unknown" initiative on
  // rows written before S18). Not shown on the card.
  byStory: z.record(z.string(), z.object({ turns: z.number(), tokens: z.number(), models: z.array(z.string()) })),
  // Dollars spent since the start of today and over the last 7 calendar days, from each session's
  // cumulative `costUsd`; ignores `since`. Raw, unrounded.
  spendToday: z.number(),
  spendWeek: z.number(),
});

export type ContextSummary = z.infer<typeof contextSummary>;

// Telemetry totals for the dashboard card; `since` is an ISO time, or null for every row. `today`
// is the ISO start of the caller's day for the spend windows; the server's local midnight without it.
export const contextSummaryRpc = defineRpc({
  name: "orchestration.context.summary",
  input: z.object({ since: z.string().nullable(), today: z.iso.datetime({ offset: true }).optional() }),
  output: contextSummary,
});

// One session's context as its pill shows it: the watch's reading and warning memory, plus the
// red threshold for "Remind me at …". The pill's status RPC returns null for a gone agent.
export const contextStatus = z.object({
  agentId: z.string(),
  reading: z.object({
    used: z.number().nullable(),
    max: z.number().nullable(),
    level: z.enum(["ok", "amber", "red", "unknown"]),
    capability: z.enum(["full", "partial", "basic"]),
    strategy: z.enum(["native", "fresh"]),
  }),
  warned: z.array(z.enum(["amber", "red"])),
  mode: z.enum(["normal", "remind", "ignore"]),
  red: z.number(),
});

export type ContextStatus = z.infer<typeof contextStatus>;

// Each listed session's pill status, in order; null for an agent that is gone.
export const contextSessionsRpc = defineRpc({
  name: "orchestration.context.sessions",
  input: z.object({ agentIds: z.array(z.string()) }),
  output: z.array(contextStatus.nullable()),
});

// The story context panel (see CONTEXT.md, "Story context"): the story's current session's
// context, burn and markers. Tokens only, no dollars.
export const storyContext = z.object({
  agentId: z.string(),
  step: z.string().nullable(),
  used: z.number().nullable(),
  max: z.number().nullable(),
  percent: z.number().nullable(),
  level: z.enum(["ok", "amber", "red", "unknown"]),
  // 1 + fresh hand-offs on this step since the story last ran another step.
  session: z.number(),
  // The agent's native + inferred compactions.
  compactions: z.number(),
  burn: z.number().nullable(),
  turnsToAct: z.union([z.number(), z.literal("now")]).nullable(),
  markers: z.object({
    warn: z.object({ tokens: z.number(), percent: z.number().nullable() }),
    act: z.object({ tokens: z.number(), percent: z.number().nullable(), word: z.enum(["compact", "hand off"]) }),
  }),
  split: z.object({ system: z.number(), conversation: z.number(), tool: z.number() }).nullable(),
  // Cost so far: Σ over the story's agents of each one's last cumulative `costUsd`; null with none.
  costUsd: z.number().nullable(),
});

export type StoryContext = z.infer<typeof storyContext>;

// null when the story has no `agent:` or Paseo says that agent is gone.
export const storyContextRpc = defineRpc({
  name: "orchestration.story.context",
  input: z.object({ repo: z.string(), initiative: z.string(), storyId: z.string() }),
  output: storyContext.nullable(),
});
