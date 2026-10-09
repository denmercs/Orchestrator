// The story context panel's arithmetic (see CONTEXT.md, "Story context"). Pure: no UI,
// host-plugin or schema imports.

import type { CompactStrategy, ContextReading, Level, Thresholds } from "./context-meter";

// The last 6 readings give the last 5 deltas.
const BURN_WINDOW = 6;

// Tokens the agent adds per turn: the mean of the last 5 deltas in its turn `used` readings,
// clamped at 0. null with fewer than 2 readings.
export function burnPerTurn(used: readonly number[]): number | null {
  const window = used.slice(-BURN_WINDOW);
  if (window.length < 2) return null;
  const average = (window[window.length - 1] - window[0]) / (window.length - 1);
  return Math.max(0, average);
}

// A timeline item, structurally: compatible with the plugin's ProviderTimelineItem. Tool calls
// carry their output in `detail.output` (shell, unknown) or `detail.content` (read, write, search).
export type TimelineItem = {
  type: string;
  status?: string;
  detail?: { type: string; output?: unknown; content?: unknown };
};

// Characters of completed tool call output in these items. Non-string outputs count as 0.
export function toolOutputChars(items: readonly TimelineItem[]): number {
  let chars = 0;
  for (const item of items) {
    if (item.type !== "tool_call" || item.status !== "completed" || !item.detail) continue;
    const { output, content } = item.detail;
    if (typeof output === "string") chars += output.length;
    if (typeof content === "string") chars += content.length;
  }
  return chars;
}

export type Split = { system: number; conversation: number; tool: number };

export type SplitInput = { system: number | null; toolChars: number | null };

// Estimated split of `used`: system is the session's first reading, tool is tool output
// characters / 4 (rounded), conversation is the rest. null when an input is missing or the
// estimate would make conversation negative.
export function estimateSplit({ used, system, toolChars }: SplitInput & { used: number | null }): Split | null {
  if (used === null || system === null || toolChars === null) return null;
  const tool = Math.round(toolChars / 4);
  const conversation = used - system - tool;
  return conversation < 0 ? null : { system, conversation, tool };
}

export type ContextPanel = {
  used: number | null;
  max: number | null;
  percent: number | null;
  level: Level;
  burn: number | null;
  turnsToAct: number | "now" | null;
  markers: {
    warn: { tokens: number; percent: number | null };
    act: { tokens: number; percent: number | null; word: "compact" | "hand off" };
  };
  split: Split | null;
};

export type ContextPanelInput = {
  reading: ContextReading;
  // The agent's turn `used` readings since its last compaction, oldest first.
  turns: readonly number[];
  thresholds: Thresholds;
  strategy: CompactStrategy;
  // The watch's split inputs; absent or null when it has none.
  split?: SplitInput | null;
};

function percentOf(tokens: number | null, max: number | null): number | null {
  return tokens === null || max === null ? null : Math.round((tokens / max) * 100);
}

// The panel's numbers. Markers are the meter's absolute thresholds (warn = amber, act = red)
// shown as a share of max; turnsToAct counts turns at the current burn until the act marker.
export function contextPanel({ reading, turns, thresholds, strategy, split }: ContextPanelInput): ContextPanel {
  const { used, max, level } = reading;
  const burn = burnPerTurn(turns);
  const act = thresholds.red;
  const turnsToAct =
    used !== null && used >= act ? "now" : used === null || !burn ? null : Math.ceil((act - used) / burn);
  return {
    used,
    max,
    percent: percentOf(used, max),
    level,
    burn,
    turnsToAct,
    markers: {
      warn: { tokens: thresholds.amber, percent: percentOf(thresholds.amber, max) },
      act: { tokens: act, percent: percentOf(act, max), word: strategy === "native" ? "compact" : "hand off" },
    },
    split: split ? estimateSplit({ used, ...split }) : null,
  };
}
