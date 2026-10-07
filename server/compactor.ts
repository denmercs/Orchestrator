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

// What a compact keeps (see CONTEXT.md, "Keep-list"). A loop agent also keeps its step and story
// so it carries on where it was after the summary.
export function keepList(labels: Record<string, string | undefined>): string[] {
  const list = [".harness/state.md", "files changed this session", "failing tests and their output"];
  if (labels["loop-step"]) list.push(`step ${labels["loop-step"]}`);
  if (labels["loop-story"]) list.push(`story ${labels["loop-story"]}`);
  return list;
}

// The native adapter: the running agent summarises itself in place.
export function nativeCompactor(send: (agentId: string, text: string) => Promise<void>): Compactor {
  return {
    async compact(agentId, list) {
      await send(agentId, `/compact Keep: ${list.join(", ")}.`);
      return { kind: "native", agentId };
    },
  };
}
