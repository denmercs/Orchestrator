// The context meter: turns what a session reports into a context reading (see CONTEXT.md,
// "Context meter"). Pure and provider-blind: no UI, host-plugin or schema imports, and no
// `provider === …` branches. The input types are structural so the host's ProviderUsage,
// ProviderCommand and timeline items fit without an import.

export type Level = "ok" | "amber" | "red" | "unknown";
export type Capability = "full" | "partial" | "basic";
export type CompactStrategy = "native" | "fresh";

export type ContextSnapshot = {
  usage: { contextWindowUsedTokens?: number; contextWindowMaxTokens?: number } | null;
  commands: { name: string }[];
};

export type Thresholds = { amber: number; red: number };

export type ContextReading = {
  used: number | null;
  max: number | null;
  level: Level;
  capability: Capability;
  strategy: CompactStrategy;
};

export function readContext(_snapshot: ContextSnapshot, _thresholds: Thresholds): ContextReading {
  throw new Error("not implemented (S2)");
}

// Per-session warning memory. The caller records each warning it raises; S2's watch resets
// memory after a detected compaction so warnings re-arm.
export type WarningMemory = {
  warned: ("amber" | "red")[];
  mode: "normal" | "remind" | "ignore";
};

export type Warning = { level: "amber" | "red" };

export function nextWarning(_memory: WarningMemory, _reading: ContextReading): Warning | null {
  throw new Error("not implemented (S2)");
}

// A timeline item as the meter sees it. Only `compaction` items matter; S2's watch passes just
// the items it has not seen yet.
export type CompactionItem = { type: string; status?: string; preTokens?: number };

export type Compaction = { kind: "native" | "inferred"; preTokens: number | null };

export function detectCompaction(
  _prev: ContextReading | null,
  _next: ContextReading,
  _items: CompactionItem[],
): Compaction | null {
  throw new Error("not implemented (S2)");
}
