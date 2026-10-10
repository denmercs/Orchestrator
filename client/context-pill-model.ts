// The context pill and card, as data (see CONTEXT.md, "Context pill"). Kept free of React and the
// Paseo client so it can be tested on its own.

import type { ContextAction, ContextStatus, ContextSummary } from "../shared/context";

export type PillTone = "ok" | "amber" | "red" | "unknown";

export type PillView = { label: string; tone: PillTone; title: string };

// 950, 182k, 1.2M.
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${Number((tokens / 1_000_000).toFixed(1))}M`;
}

const UNKNOWN: PillView = {
  label: "Context ?",
  tone: "unknown",
  title: "Context unknown: this agent reports no usage",
};

export function pillView(status: ContextStatus | null): PillView {
  const reading = status?.reading;
  if (!reading || reading.level === "unknown" || reading.used === null) return UNKNOWN;
  const used = formatTokens(reading.used);
  const label = reading.max === null ? used : `${used} / ${formatTokens(reading.max)}`;
  const strategy = reading.strategy === "native" ? "Compact: /compact in place" : "Compact: fresh session";
  return { label, tone: reading.level, title: `Context ${reading.level} · ${label} · ${strategy}` };
}

export type PillMenuItem = { action: ContextAction; title: string; disabled: boolean };

// The pill's menu, in order. Compact and Start fresh wait for the turn to end (the fresh adapter
// refuses mid-turn); Remind and Ignore are off once that mode is on.
export function pillMenu(status: ContextStatus | null, running: boolean): PillMenuItem[] {
  const mode = status?.mode ?? "normal";
  const red = status ? formatTokens(status.red) : "red";
  return [
    { action: "compact", title: "Compact now", disabled: running },
    { action: "fresh", title: "Start fresh", disabled: running },
    { action: "remind", title: `Remind me at ${red}`, disabled: mode === "remind" },
    { action: "ignore", title: "Ignore", disabled: mode === "ignore" },
    { action: "skip-auto", title: "Don't auto-compact", disabled: !status?.auto },
  ];
}

export type ContextToast = { variant: "amber" | "red" | "error"; message: string };

// With auto-compact armed the toast says what will happen; otherwise it is the plain warning.
function warningMessage(level: "amber" | "red", status: ContextStatus): string {
  const plain = `Context ${level}: ${pillView(status).label}`;
  if (!status.auto) return plain;
  if (level === "red") return `${plain}; compacting now.`;
  return `${plain}; compacts automatically at ${formatTokens(status.red)}. Pick "Don't auto-compact" in the pill menu to stop it.`;
}

// Toasts waiting for each session's pill to show them. A level toasts once per session; the first
// load only seeds, so warnings raised before the app started show as the pill colour alone.
export function createToastQueue() {
  const shown = new Set<string>();
  const queued = new Map<string, ContextToast[]>();
  let seeded = false;

  function push(agentId: string, toast: ContextToast) {
    queued.set(agentId, [...(queued.get(agentId) ?? []), toast]);
  }

  return {
    load(statuses: readonly (ContextStatus | null)[]) {
      for (const status of statuses) {
        if (!status) continue;
        // A compaction re-arms the session's warnings server-side; forget levels it no longer holds.
        for (const level of ["amber", "red"] as const) {
          if (!status.warned.includes(level)) shown.delete(`${status.agentId}:${level}`);
        }
        for (const level of status.warned) {
          const key = `${status.agentId}:${level}`;
          if (shown.has(key)) continue;
          shown.add(key);
          if (seeded) push(status.agentId, { variant: level, message: warningMessage(level, status) });
        }
      }
      seeded = true;
    },
    fail(agentId: string, message: string) {
      push(agentId, { variant: "error", message });
    },
    take(agentId: string): ContextToast[] {
      const toasts = queued.get(agentId) ?? [];
      queued.delete(agentId);
      return toasts;
    },
  };
}

// Numbers each status fetch per agent, so a slow older fetch can't overwrite a newer one.
export function createRequestSequence() {
  const latest = new Map<string, number>();
  let next = 0;
  return {
    start(agentIds: readonly string[]): number {
      next += 1;
      for (const agentId of agentIds) latest.set(agentId, next);
      return next;
    },
    isLatest(agentId: string, request: number): boolean {
      return latest.get(agentId) === request;
    },
  };
}

// The parts of a Paseo agent snapshot the refetch trigger reads.
export type UsageSnapshot = {
  status: string;
  lastUsage?: { contextWindowUsedTokens?: number; contextWindowMaxTokens?: number } | null;
};

// Whether an agent upsert should refetch its pill status: a new agent, a changed used/max, or a
// turn that just ended (the watch writes warnings at turn end).
export function usageChanged(prev: UsageSnapshot | undefined, next: UsageSnapshot): boolean {
  if (!prev) return true;
  if (prev.status === "running" && next.status === "idle") return true;
  return (
    prev.lastUsage?.contextWindowUsedTokens !== next.lastUsage?.contextWindowUsedTokens ||
    prev.lastUsage?.contextWindowMaxTokens !== next.lastUsage?.contextWindowMaxTokens
  );
}

export type SummaryTile = { label: string; value: string };

// The dashboard card's tiles. Taken counts compacts someone chose (native + fresh); Claude's own
// auto-compacts show apart so they don't inflate it.
export function summaryTiles(summary: ContextSummary): SummaryTile[] {
  const taken = summary.compactions.native + summary.compactions.fresh;
  return [
    { label: "Sessions over threshold", value: String(summary.sessionsOverThreshold) },
    { label: "Warnings", value: String(summary.warnings) },
    { label: "Compactions", value: `taken ${taken} (${summary.compactions.auto} auto) vs ignored ${summary.ignored}` },
    { label: "Auto-compacts", value: String(summary.compactions.inferred) },
    { label: "Tokens avoided", value: formatTokens(summary.tokensAvoided) },
  ];
}

const LOOP_STEPS = ["diagnose", "plan", "implement", "review", "fix", "pr"];

// The card's "Context tokens per step" row: loop steps in run order, then any other step A–Z. Tokens are
// summed context size at each turn end, not billed tokens.
export function stepTiles(summary: ContextSummary): SummaryTile[] {
  const rank = (step: string) => {
    const index = LOOP_STEPS.indexOf(step);
    return index === -1 ? LOOP_STEPS.length : index;
  };
  return Object.keys(summary.byStep)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((step) => {
      const { turns, tokens, models } = summary.byStep[step];
      return { label: step, value: `${formatTokens(tokens)} · ${turns} turn${turns === 1 ? "" : "s"} · ${models.join(", ")}` };
    });
}
