import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  detectCompaction,
  nextWarning,
  readContext,
  type CompactionItem,
  type ContextReading,
  type ContextSnapshot,
  type Thresholds,
  type WarningMemory,
} from "../shared/context-meter";
import type { ContextAction } from "../shared/context";
import { keepList, nativeCompactor } from "./compactor";
import { recordTelemetry, type TelemetryEvent, type TelemetryRow } from "./context-telemetry";

// The context watch (see CONTEXT.md, "Context watch"): on each turn end it takes a context
// reading, records telemetry and decides on a warning. It talks to Paseo only through the
// port, so tests use fakes. Warning memory and readings live in server memory and are never
// persisted; a restart can repeat a warning once.

export type WatchAgent = {
  usage: ContextSnapshot["usage"];
  commands: ContextSnapshot["commands"];
  labels: Record<string, string>;
};

export type WatchPort = {
  // null when the agent is archived or unknown.
  readAgent(agentId: string): Promise<WatchAgent | null>;
  send(agentId: string, text: string): Promise<void>;
  record(row: TelemetryRow): Promise<void>;
  thresholds(): Promise<Thresholds>;
  now(): string;
};

type PaseoApi = PluginHandlerContext["paseo"];

// The real port. `paseo` is the latest handle the plugin was given (null before the first
// event), so one watch can live for the plugin's lifetime.
export function paseoPort(paseo: () => PaseoApi | null, thresholds: () => Promise<Thresholds>): WatchPort {
  return {
    async readAgent(agentId) {
      const api = paseo();
      if (!api) return null;
      const ref = api.agents.ref(agentId);
      const refreshed = await ref.refresh();
      if (!refreshed) return null;
      // A provider that cannot list commands reports `error`; read that as no commands.
      const listed = await ref.commands().catch(() => null);
      return {
        usage: refreshed.agent.lastUsage ?? null,
        commands: listed && !listed.error ? listed.commands : [],
        labels: refreshed.agent.labels ?? {},
      };
    },
    async send(agentId, text) {
      const api = paseo();
      if (!api) throw new Error("Paseo is not connected yet.");
      await api.agents.ref(agentId).send(text);
    },
    record: (row) => recordTelemetry(row),
    thresholds,
    now: () => new Date().toISOString(),
  };
}

export type TurnEnded = {
  agent: { id: string; provider: string };
  // The whole timeline so far.
  timeline: readonly CompactionItem[];
};

export type ActResult = { ok: boolean; error: string | null; agentId: string | null };

const FRESH_LATER = "Start fresh arrives in S3";

type SessionState = {
  provider: string;
  reading: ContextReading | null;
  memory: WarningMemory;
  // Timeline length at the last turn end; items past it are unseen. null until a turn end.
  cursor: number | null;
};

// Items this turn end has not seen yet. On first sight (or when the timeline was replaced and
// got shorter) only items after the last user message count, so a daemon restart does not
// record old compactions again.
function unseenItems(timeline: readonly CompactionItem[], cursor: number | null): readonly CompactionItem[] {
  if (cursor !== null && cursor <= timeline.length) return timeline.slice(cursor);
  let lastUser = -1;
  timeline.forEach((item, index) => {
    if (item.type === "user_message") lastUser = index;
  });
  return timeline.slice(lastUser + 1);
}

export function createContextWatch(port: WatchPort) {
  const sessions = new Map<string, SessionState>();
  const native = nativeCompactor(port.send);

  async function record(
    agentId: string,
    state: SessionState,
    labels: Record<string, string>,
    event: TelemetryEvent,
    extra: Pick<TelemetryRow, "level" | "preTokens"> = {},
  ): Promise<void> {
    await port.record({
      at: port.now(),
      agentId,
      provider: state.provider,
      step: labels["loop-step"] ?? null,
      used: state.reading?.used ?? null,
      max: state.reading?.max ?? null,
      event,
      ...extra,
    });
  }

  return {
    async onTurnEnded(event: TurnEnded): Promise<void> {
      const agentId = event.agent.id;
      const agent = await port.readAgent(agentId);
      if (!agent) return;
      const reading = readContext(agent, await port.thresholds());
      const state: SessionState = sessions.get(agentId) ?? {
        provider: event.agent.provider,
        reading: null,
        memory: { warned: [], mode: "normal" },
        cursor: null,
      };
      sessions.set(agentId, state);
      const unseen = unseenItems(event.timeline, state.cursor);
      const compaction = detectCompaction(state.reading, reading, unseen);
      state.provider = event.agent.provider;
      state.reading = reading;
      state.cursor = event.timeline.length;

      if (compaction) {
        // Recorded here rather than when Compact is pressed: this sees the real preTokens and the
        // smaller reading, and counts Claude's own auto-compacts the same way.
        await record(agentId, state, agent.labels, `compact.${compaction.kind}`, {
          ...(compaction.preTokens === null ? {} : { preTokens: compaction.preTokens }),
        });
        state.memory = { warned: [], mode: "normal" };
      }
      await record(agentId, state, agent.labels, "turn");
      const warning = nextWarning(state.memory, reading);
      if (warning) {
        state.memory.warned.push(warning.level);
        await record(agentId, state, agent.labels, "warning", { level: warning.level });
      }
    },

    // A pill action on one session. Compact sends `/compact` for a native session; its
    // `compact.native` row is written by the next turn end.
    async act({ agentId, action }: { agentId: string; action: ContextAction }): Promise<ActResult> {
      if (action === "fresh") return { ok: false, error: FRESH_LATER, agentId: null };
      const agent = await port.readAgent(agentId);
      if (!agent) return { ok: false, error: "That session is no longer running.", agentId: null };
      const reading = readContext(agent, await port.thresholds());
      if (action === "compact") {
        if (reading.strategy !== "native") return { ok: false, error: FRESH_LATER, agentId: null };
        const result = await native.compact(agentId, keepList(agent.labels));
        return { ok: true, error: null, agentId: result.agentId };
      }
      const state: SessionState = sessions.get(agentId) ?? {
        provider: "unknown",
        reading,
        memory: { warned: [], mode: "normal" },
        cursor: null,
      };
      sessions.set(agentId, state);
      state.memory.mode = action;
      await record(agentId, state, agent.labels, action);
      return { ok: true, error: null, agentId };
    },
  };
}
