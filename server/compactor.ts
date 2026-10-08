import type { CompactStrategy } from "../shared/context-meter";
import { LOOP_AGENT_KIND } from "../shared/initiative-loop";

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

// Where an ordinary session writes its handoff before a fresh compact, relative to its cwd.
export const HANDOFF_FILE = ".harness/handoff.md";

// The last turn an ordinary session runs before a fresh compact.
export function handoffAsk(list: string[]): string {
  return [
    `Your context is nearly full, so a new session will carry on this work. Write \`${HANDOFF_FILE}\` for it,`,
    "replacing any earlier one: the goal, what is done, what is next, the files you touched, failing tests",
    `and their output, and decisions made along the way. Keep: ${list.join(", ")}.`,
    "Write the file and stop; don't start anything else.",
  ].join(" ");
}

// What the fresh adapter reads from the old session.
export type FreshSession = {
  // null when the session has no workspace; the new one is created by cwd.
  workspaceId: string | null;
  cwd: string;
  config: { provider: string; modeId?: string; thinkingOptionId?: string };
  title: string | null;
  labels: Record<string, string>;
  // Mid-turn sessions are refused.
  running: boolean;
};

export type FreshCreate = {
  workspaceId: string | null;
  cwd: string;
  config: FreshSession["config"];
  title: string;
  labels: Record<string, string>;
  prompt: string;
};

// Everything the fresh adapter needs from Paseo and the initiative loop.
export type FreshPort = {
  // null when the agent is archived or unknown.
  session(agentId: string): Promise<FreshSession | null>;
  // Runs one turn that writes the handoff; rejects when the turn fails.
  handoff(agentId: string, cwd: string, text: string): Promise<void>;
  // Returns the new agent's id.
  create(input: FreshCreate): Promise<string>;
  archive(agentId: string): Promise<void>;
  // A loop agent's step prompt plus the resume line, or null when its story can't be found.
  loopPrompt(labels: Record<string, string>): Promise<string | null>;
  // Moves a loop story's `agent:` from the old session to the new one.
  handOver(labels: Record<string, string>, fromId: string, toId: string): Promise<void>;
};

const CONTINUE = `Continue from \`${HANDOFF_FILE}\`. An earlier session ran out of context and wrote it for you.`;

// The fresh adapter: a new agent in the same workspace carries on, and the old one is archived.
// A loop agent restarts its step from `.harness/state.md`; any other session writes a handoff first.
export function freshCompactor(port: FreshPort): Compactor {
  return {
    async compact(agentId, list) {
      const old = await port.session(agentId);
      if (!old) throw new Error("That session is no longer running.");
      if (old.running) throw new Error("Wait for the turn to end, then start fresh.");
      const loop = old.labels.kind === LOOP_AGENT_KIND ? await port.loopPrompt(old.labels) : null;
      if (!loop) await port.handoff(agentId, old.cwd, handoffAsk(list));
      const created = await port.create({
        workspaceId: old.workspaceId,
        cwd: old.cwd,
        config: old.config,
        title: `${old.title ?? "Session"} · fresh`.slice(0, 60),
        labels: { ...old.labels, "context-from": agentId },
        prompt: loop ?? CONTINUE,
      });
      if (loop) await port.handOver(old.labels, agentId, created);
      await port.archive(agentId);
      return { kind: "fresh", agentId: created };
    },
  };
}
