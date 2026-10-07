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

export function readContext(snapshot: ContextSnapshot, thresholds: Thresholds): ContextReading {
  const used = snapshot.usage?.contextWindowUsedTokens ?? null;
  const max = snapshot.usage?.contextWindowMaxTokens ?? null;
  // Exact name match: `autocompact` and friends are not the native compact command.
  const hasCompact = snapshot.commands.some((command) => command.name === "compact");
  const level: Level =
    used === null ? "unknown" : used >= thresholds.red ? "red" : used >= thresholds.amber ? "amber" : "ok";
  const capability: Capability = used === null ? "basic" : hasCompact ? "full" : "partial";
  return { used, max, level, capability, strategy: hasCompact ? "native" : "fresh" };
}

// Per-session warning memory. The caller records each warning it raises; S2's watch resets
// memory after a detected compaction so warnings re-arm.
export type WarningMemory = {
  warned: ("amber" | "red")[];
  mode: "normal" | "remind" | "ignore";
};

export type Warning = { level: "amber" | "red" };

// Once per level: amber, then red. Remind waits for red; Ignore stays silent.
export function nextWarning(memory: WarningMemory, reading: ContextReading): Warning | null {
  if (memory.mode === "ignore") return null;
  if (reading.level !== "amber" && reading.level !== "red") return null;
  if (reading.level === "amber" && memory.mode === "remind") return null;
  return memory.warned.includes(reading.level) ? null : { level: reading.level };
}

// A timeline item as the meter sees it. Only `compaction` items matter; S2's watch passes just
// the items it has not seen yet.
export type CompactionItem = { type: string; status?: string; preTokens?: number };

export type Compaction = { kind: "native" | "inferred"; preTokens: number | null };

// A completed `compaction` item is native. Without one, a drop to under half the previous
// reading is inferred (an auto-compact the session did not report).
export function detectCompaction(
  prev: ContextReading | null,
  next: ContextReading,
  items: readonly CompactionItem[],
): Compaction | null {
  const item = items.find((i) => i.type === "compaction" && i.status === "completed");
  if (item) return { kind: "native", preTokens: item.preTokens ?? prev?.used ?? null };
  if (prev?.used == null || next.used === null) return null;
  return next.used < prev.used / 2 ? { kind: "inferred", preTokens: prev.used } : null;
}
