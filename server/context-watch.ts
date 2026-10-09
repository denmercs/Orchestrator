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
import type { ContextAction, ContextStatus } from "../shared/context";
import { toolOutputChars, type SplitInput, type TimelineItem } from "../shared/context-panel";
import { freshCompactor, keepList, nativeCompactor, type FreshPort } from "./compactor";
import { excludeHarness } from "./harness-layout";
import { recordTelemetry, type TelemetryEvent, type TelemetryRow } from "./context-telemetry";

// The context watch (see CONTEXT.md, "Context watch"): on each turn end it takes a context
// reading, records telemetry and decides on a warning. It talks to Paseo only through the
// port, so tests use fakes. Warning memory and readings live in server memory and are never
// persisted; a restart can repeat a warning once.

export type WatchAgent = {
  usage: ContextSnapshot["usage"];
  commands: ContextSnapshot["commands"];
  labels: Record<string, string>;
  // Recorded for analysis only, never branched on.
  model: string | null;
  // The session's cumulative cost so far (`lastUsage.totalCostUsd`); null when the provider reports none.
  costUsd: number | null;
};

export type WatchPort = {
  // null when the agent is archived or unknown.
  readAgent(agentId: string): Promise<WatchAgent | null>;
  send(agentId: string, text: string): Promise<void>;
  record(row: TelemetryRow): Promise<void>;
  thresholds(): Promise<Thresholds>;
  now(): string;
  // The fresh adapter's port.
  fresh: FreshPort;
};

type PaseoApi = PluginHandlerContext["paseo"];

// The initiative loop's side of a fresh compact (see server/initiative-loop.ts).
export type LoopHandover = Pick<FreshPort, "handOver"> & {
  resumePrompt: FreshPort["loopPrompt"];
};

// The handoff turn gets this long before the fresh compact gives up.
const HANDOFF_TIMEOUT_MS = 10 * 60_000;

function connected(paseo: () => PaseoApi | null): PaseoApi {
  const api = paseo();
  if (!api) throw new Error("Paseo is not connected yet.");
  return api;
}

// The fresh adapter's real port.
function paseoFreshPort(paseo: () => PaseoApi | null, loop: LoopHandover): FreshPort {
  return {
    async session(agentId) {
      const refreshed = await connected(paseo).agents.ref(agentId).refresh();
      if (!refreshed || refreshed.agent.archivedAt) return null;
      const { agent } = refreshed;
      return {
        workspaceId: agent.workspaceId ?? null,
        cwd: agent.cwd,
        config: {
          provider: agent.model ? `${agent.provider}/${agent.model}` : agent.provider,
          ...(agent.currentModeId ? { modeId: agent.currentModeId } : {}),
          ...(agent.thinkingOptionId ? { thinkingOptionId: agent.thinkingOptionId } : {}),
        },
        title: agent.title,
        labels: agent.labels ?? {},
        running: agent.status === "running",
      };
    },
    async handoff(agentId, cwd, text) {
      // The handoff lives in .harness/, which must never show in git.
      await excludeHarness(cwd);
      const result = await connected(paseo).agents.ref(agentId).run(text, { timeoutMs: HANDOFF_TIMEOUT_MS });
      if (result.status !== "idle") throw new Error(result.error ?? `The handoff turn ended with ${result.status}.`);
    },
    async create({ workspaceId, cwd, ...options }) {
      const api = connected(paseo);
      const agent = workspaceId
        ? await api.workspaces.ref(workspaceId).agents.create(options)
        : await api.agents.create({ cwd, ...options });
      return agent.id;
    },
    async archive(agentId) {
      await connected(paseo).agents.ref(agentId).archive();
    },
    loopPrompt: (labels) => loop.resumePrompt(labels),
    handOver: (labels, fromId, toId) => loop.handOver(labels, fromId, toId),
  };
}

// The real port. `paseo` is the latest handle the plugin was given (null before the first
// event), so one watch can live for the plugin's lifetime.
export function paseoPort(
  paseo: () => PaseoApi | null,
  thresholds: () => Promise<Thresholds>,
  loop: LoopHandover,
): WatchPort {
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
        model: refreshed.agent.model ?? null,
        costUsd: refreshed.agent.lastUsage?.totalCostUsd ?? null,
      };
    },
    async send(agentId, text) {
      await connected(paseo).agents.ref(agentId).send(text);
    },
    record: (row) => recordTelemetry(row),
    thresholds,
    now: () => new Date().toISOString(),
    fresh: paseoFreshPort(paseo, loop),
  };
}

export type TurnEnded = {
  agent: { id: string; provider: string };
  // The whole timeline so far.
  timeline: readonly WatchItem[];
};

type WatchItem = CompactionItem & TimelineItem;

// What the story context panel reads for one session (see CONTEXT.md, "Story context").
export type LiveSession = {
  agentId: string;
  reading: ContextReading;
  labels: Record<string, string>;
  // null when the watch has no trustworthy split inputs for this session.
  split: SplitInput | null;
};

export type ActResult = { ok: boolean; error: string | null; agentId: string | null };

type SessionState = {
  provider: string;
  reading: ContextReading | null;
  memory: WarningMemory;
  // Timeline length at the last turn end; items past it are unseen. null until a turn end.
  cursor: number | null;
  // Split inputs: system is the session's first reading, toolChars the tool output characters of
  // every later turn. null unless the watch saw the first turn, and from any compaction on.
  split: { system: number; toolChars: number } | null;
};

// Items this turn end has not seen yet. On first sight (or when the timeline was replaced and
// got shorter) only items after the last user message count, so a daemon restart does not
// record old compactions again.
function unseenItems(timeline: readonly WatchItem[], cursor: number | null): readonly WatchItem[] {
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
  const fresh = freshCompactor(port.fresh);
  // Sessions mid-way through a fresh compact, so a second press can't start another.
  const handingOver = new Set<string>();
  // New sessions from a fresh compact → the old session's last `used`. Their first turn end writes
  // the `compact.fresh` row, so it has a real reading to count tokens avoided against.
  const pendingFresh = new Map<string, number | null>();
  // Turn ends still being processed, so a status read waits for the warning they may write.
  const turnEnds = new Map<string, Promise<void>>();

  async function startFresh(agentId: string, labels: Record<string, string>, used: number | null): Promise<ActResult> {
    if (handingOver.has(agentId)) return { ok: false, error: "That session is already starting fresh.", agentId: null };
    handingOver.add(agentId);
    try {
      const result = await fresh.compact(agentId, keepList(labels));
      pendingFresh.set(result.agentId, used);
      // The old session is archived and sends no more turn ends.
      sessions.delete(agentId);
      return { ok: true, error: null, agentId: result.agentId };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause), agentId: null };
    } finally {
      handingOver.delete(agentId);
    }
  }

  async function record(
    agentId: string,
    state: SessionState,
    agent: WatchAgent,
    event: TelemetryEvent,
    extra: Pick<TelemetryRow, "level" | "preTokens"> = {},
  ): Promise<void> {
    const { labels } = agent;
    const rawCycle = labels["loop-cycle"];
    await port.record({
      at: port.now(),
      agentId,
      provider: state.provider,
      step: labels["loop-step"] ?? null,
      used: state.reading?.used ?? null,
      max: state.reading?.max ?? null,
      event,
      ...extra,
      model: agent.model,
      cycle: rawCycle !== undefined && /^\d+$/.test(rawCycle) ? Number(rawCycle) : null,
      story: labels["loop-story"] ?? null,
      initiative: labels["loop-initiative"] ?? null,
      costUsd: agent.costUsd,
    });
  }

  async function processTurnEnd(event: TurnEnded): Promise<void> {
    const agentId = event.agent.id;
    const agent = await port.readAgent(agentId);
    if (!agent) return;
    const reading = readContext(agent, await port.thresholds());
    const state: SessionState = sessions.get(agentId) ?? {
      provider: event.agent.provider,
      reading: null,
      memory: { warned: [], mode: "normal" },
      cursor: null,
      split: null,
    };
    sessions.set(agentId, state);
    const unseen = unseenItems(event.timeline, state.cursor);
    const compaction = detectCompaction(state.reading, reading, unseen);
    if (state.cursor === null) {
      // First sight: a timeline with at most one user message is the session's first turn, and
      // its tool output is already inside the first reading.
      const firstTurn = event.timeline.filter((item) => item.type === "user_message").length <= 1;
      state.split = firstTurn && !compaction && reading.used !== null ? { system: reading.used, toolChars: 0 } : null;
    } else if (compaction || state.cursor > event.timeline.length) {
      state.split = null;
    } else if (state.split) {
      state.split.toolChars += toolOutputChars(unseen);
    }
    state.provider = event.agent.provider;
    state.reading = reading;
    state.cursor = event.timeline.length;

    if (compaction) {
      // Recorded here rather than when Compact is pressed: this sees the real preTokens and the
      // smaller reading, and counts Claude's own auto-compacts the same way.
      await record(agentId, state, agent, `compact.${compaction.kind}`, {
        ...(compaction.preTokens === null ? {} : { preTokens: compaction.preTokens }),
      });
      state.memory = { warned: [], mode: "normal" };
    }
    if (pendingFresh.has(agentId)) {
      const preTokens = pendingFresh.get(agentId) ?? null;
      pendingFresh.delete(agentId);
      await record(agentId, state, agent, "compact.fresh", preTokens === null ? {} : { preTokens });
    }
    await record(agentId, state, agent, "turn");
    const warning = nextWarning(state.memory, reading);
    if (warning) {
      state.memory.warned.push(warning.level);
      await record(agentId, state, agent, "warning", { level: warning.level });
    }
  }

  return {
    async onTurnEnded(event: TurnEnded): Promise<void> {
      const agentId = event.agent.id;
      const done = processTurnEnd(event);
      const tracked = done.catch(() => {});
      turnEnds.set(agentId, tracked);
      try {
        await done;
      } finally {
        if (turnEnds.get(agentId) === tracked) turnEnds.delete(agentId);
      }
    },

    // Each session's pill status. A session the watch has seen gives its reading from the last
    // turn end; one it has not is read now, with empty memory; a gone one is null.
    async sessions(agentIds: readonly string[]): Promise<(ContextStatus | null)[]> {
      const thresholds = await port.thresholds();
      return Promise.all(
        agentIds.map(async (agentId): Promise<ContextStatus | null> => {
          await turnEnds.get(agentId);
          const state = sessions.get(agentId);
          let reading = state?.reading ?? null;
          if (!reading) {
            const agent = await port.readAgent(agentId);
            if (!agent) return null;
            reading = readContext(agent, thresholds);
          }
          const memory = state?.memory ?? { warned: [], mode: "normal" };
          return { agentId, reading, warned: [...memory.warned], mode: memory.mode, red: thresholds.red };
        }),
      );
    },

    // One session's live state for the story context panel: the reading from its last turn end
    // (read now when the watch has not seen it), its current labels and the split inputs. null
    // when the agent is gone.
    async live(agentId: string): Promise<LiveSession | null> {
      await turnEnds.get(agentId);
      const agent = await port.readAgent(agentId);
      if (!agent) return null;
      const state = sessions.get(agentId);
      const reading = state?.reading ?? readContext(agent, await port.thresholds());
      return { agentId, reading, labels: agent.labels, split: state?.split ? { ...state.split } : null };
    },

    // A pill action on one session. Compact sends `/compact` for a native session; its
    // `compact.native` row is written by the next turn end. Start fresh, and Compact on a session
    // without `/compact`, hand over to a new agent and return its id.
    async act({ agentId, action }: { agentId: string; action: ContextAction }): Promise<ActResult> {
      const agent = await port.readAgent(agentId);
      if (!agent) return { ok: false, error: "That session is no longer running.", agentId: null };
      const reading = readContext(agent, await port.thresholds());
      if (action === "fresh" || (action === "compact" && reading.strategy === "fresh")) {
        return startFresh(agentId, agent.labels, reading.used ?? sessions.get(agentId)?.reading?.used ?? null);
      }
      if (action === "compact") {
        const result = await native.compact(agentId, keepList(agent.labels));
        return { ok: true, error: null, agentId: result.agentId };
      }
      const state: SessionState = sessions.get(agentId) ?? {
        provider: "unknown",
        reading,
        memory: { warned: [], mode: "normal" },
        cursor: null,
        split: null,
      };
      sessions.set(agentId, state);
      state.memory.mode = action;
      await record(agentId, state, agent, action);
      return { ok: true, error: null, agentId };
    },
  };
}
