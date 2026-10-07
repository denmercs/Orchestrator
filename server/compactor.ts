import type { CompactStrategy } from "../shared/context-meter";

// Carries out a compact strategy for one session (see CONTEXT.md, "Compactor"). One adapter per
// strategy; each holds its own Paseo handle, so the interface carries no Paseo types. The
// reading's `strategy` picks the adapter.

export type CompactResult = {
  kind: CompactStrategy;
  // The session that carries on: the same agent after native, the new one after fresh.
  agentId: string;
};

export interface Compactor {
  compact(agentId: string, keepList: string[]): Promise<CompactResult>;
}
