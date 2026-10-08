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
});

export type ContextSummary = z.infer<typeof contextSummary>;

// Telemetry totals for the dashboard card; `since` is an ISO time, or null for every row.
export const contextSummaryRpc = defineRpc({
  name: "orchestration.context.summary",
  input: z.object({ since: z.string().nullable() }),
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
