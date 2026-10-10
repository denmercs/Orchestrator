import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  detectCompaction,
  nextWarning,
  readContext,
  shouldAutoCompact,
  type CompactionItem,
  type ContextReading,
  type ContextSnapshot,
  type Thresholds,
  type WarningMemory,
} from "../shared/context-meter";
import type { ContextAction, ContextStatus } from "../shared/context";
import { toolOutputChars, type SplitInput, type TimelineItem } from "../shared/context-panel";
import { exploration, toolSteps, type Explore, type ToolItem, type ToolStep } from "../shared/exploration";
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
  // Mid-turn now, and whether a permission request is waiting; both hold off an auto-compact.
  running: boolean;
  pendingPermissions: boolean;
};

export type WatchPort = {
  // null when the agent is archived or unknown.
  readAgent(agentId: string): Promise<WatchAgent | null>;
  send(agentId: string, text: string): Promise<void>;
  record(row: TelemetryRow): Promise<void>;
  thresholds(): Promise<Thresholds>;
  // Whether the red threshold compacts on its own (the context setting).
  autoCompact(): Promise<boolean>;
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
  autoCompact: () => Promise<boolean>,
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
        running: refreshed.agent.status === "running",
        pendingPermissions: refreshed.agent.pendingPermissions.length > 0,
      };
    },
    async send(agentId, text) {
      await connected(paseo).agents.ref(agentId).send(text);
    },
    record: (row) => recordTelemetry(row),
    thresholds,
    autoCompact,
    now: () => new Date().toISOString(),
    fresh: paseoFreshPort(paseo, loop),
  };
}

export type TurnEnded = {
  agent: { id: string; provider: string };
  // The whole timeline so far.
  timeline: readonly WatchItem[];
  // How the turn ended; missing counts as completed.
  outcome?: { kind: "completed" | "failed" | "canceled" };
};

type WatchItem = CompactionItem & TimelineItem & ToolItem;

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
  // Whether the agent is a loop or replay step, as of the last turn end (those never auto-compact).
  loop?: boolean;
  // Split inputs: system is the session's first reading, toolChars the tool output characters of
  // every later turn. null unless the watch saw the first turn, and from any compaction on.
  split: { system: number; toolChars: number } | null;
  // The exploration count (see CONTEXT.md, "Telemetry row"): the steps seen so far, and the final
  // count once an edit froze it. null when the watch lost the count (first sight mid-session, or
  // the timeline was replaced), for the agent's life.
  explore: { steps: ToolStep[]; frozen: Explore | null } | null;
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

// The step whose exploration is counted: a loop agent's own, else a replay agent's (its row `step`
// stays null so live stats are not polluted).
function countedStep(labels: Record<string, string>): string | undefined {
  return labels["loop-step"] ?? labels["replay-step"];
}

// The count to write on a turn row: the frozen one, else the steps so far; null when lost.
function runningCount(state: SessionState, step: string): Explore | null {
  const { explore } = state;
  if (!explore) return null;
  return explore.frozen ?? exploration(explore.steps, { step });
}

export function createContextWatch(port: WatchPort) {
  const sessions = new Map<string, SessionState>();
  const native = nativeCompactor(port.send);
  const fresh = freshCompactor(port.fresh);
  // Sessions mid-way through a fresh compact, so a second press can't start another.
  const handingOver = new Set<string>();
  // New sessions from a fresh compact → the old session's last `used`. Their first turn end writes
  // the `compact.fresh` row, so it has a real reading to count tokens avoided against.
  // The entry also says whether the watch started it (`trigger: "auto"`).
  const pendingFresh = new Map<string, { used: number | null; trigger?: "auto" }>();
  // Sessions with an auto compact in flight; the next compaction row consumes the mark.
  const autoPending = new Set<string>();
  // Turn ends still being processed, so a status read waits for the warning they may write.
  const turnEnds = new Map<string, Promise<void>>();

  async function startFresh(
    agentId: string,
    labels: Record<string, string>,
    used: number | null,
    trigger?: "auto",
  ): Promise<ActResult> {
    if (handingOver.has(agentId)) return { ok: false, error: "That session is already starting fresh.", agentId: null };
    handingOver.add(agentId);
    try {
      const result = await fresh.compact(agentId, keepList(labels));
      pendingFresh.set(result.agentId, { used, ...(trigger ? { trigger } : {}) });
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
    extra: Pick<TelemetryRow, "level" | "preTokens" | "explore" | "trigger"> = {},
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
      memory: { warned: [], mode: "normal", auto: "armed" },
      cursor: null,
      split: null,
      explore: null,
    };
    sessions.set(agentId, state);
    const unseen = unseenItems(event.timeline, state.cursor);
    const compaction = detectCompaction(state.reading, reading, unseen);
    if (state.cursor === null) {
      // First sight: a timeline with at most one user message is the session's first turn, and
      // its tool output is already inside the first reading.
      const firstTurn = event.timeline.filter((item) => item.type === "user_message").length <= 1;
      state.split = firstTurn && !compaction && reading.used !== null ? { system: reading.used, toolChars: 0 } : null;
      state.explore = firstTurn ? { steps: [], frozen: null } : null;
    } else if (compaction || state.cursor > event.timeline.length) {
      state.split = null;
      if (state.cursor > event.timeline.length) state.explore = null;
    } else if (state.split) {
      state.split.toolChars += toolOutputChars(unseen);
    }
    const { explore } = state;
    if (explore && !explore.frozen) {
      explore.steps.push(...toolSteps(unseen));
      const count = exploration(explore.steps, { step: countedStep(agent.labels) ?? null });
      if (count.edited) {
        explore.frozen = count;
        explore.steps = [];
      }
    }
    state.provider = event.agent.provider;
    state.reading = reading;
    state.loop = countedStep(agent.labels) !== undefined;
    state.cursor = event.timeline.length;

    if (compaction) {
      // Recorded here rather than when Compact is pressed: this sees the real preTokens and the
      // smaller reading, and counts Claude's own auto-compacts the same way.
      await record(agentId, state, agent, `compact.${compaction.kind}`, {
        ...(compaction.preTokens === null ? {} : { preTokens: compaction.preTokens }),
        ...(autoPending.delete(agentId) ? { trigger: "auto" as const } : {}),
      });
      state.memory = {
        warned: [],
        mode: "normal",
        auto: state.memory.auto === "skipped" ? "skipped" : "armed",
      };
    }
    if (pendingFresh.has(agentId)) {
      const { used, trigger } = pendingFresh.get(agentId) ?? { used: null };
      pendingFresh.delete(agentId);
      await record(agentId, state, agent, "compact.fresh", {
        ...(used === null ? {} : { preTokens: used }),
        ...(trigger ? { trigger } : {}),
      });
    }
    // Only a loop or replay agent has an exploration count; null means the watch lost it.
    const loopStep = countedStep(agent.labels);
    const counted = loopStep === undefined ? {} : { explore: runningCount(state, loopStep) };
    await record(agentId, state, agent, "turn", counted);
    const warning = nextWarning(state.memory, reading);
    if (warning) {
      state.memory.warned.push(warning.level);
      await record(agentId, state, agent, "warning", { level: warning.level });
    }
    const fire = shouldAutoCompact(state.memory, reading, {
      enabled: await port.autoCompact(),
      running: agent.running,
      pendingPermissions: agent.pendingPermissions,
      completed: (event.outcome?.kind ?? "completed") === "completed",
      loop: loopStep !== undefined,
    });
    if (fire) {
      state.memory.auto = "sent";
      if (reading.strategy === "fresh") {
        // A fresh handoff runs a long turn: start it after the rows are written and don't wait,
        // so status reads aren't held up. startFresh reports its own failure and never throws.
        void startFresh(agentId, agent.labels, reading.used, "auto");
      } else {
        autoPending.add(agentId);
        try {
          await native.compact(agentId, keepList(agent.labels));
        } catch (cause) {
          // Nothing was sent, so a later manual compact must not be tagged auto.
          autoPending.delete(agentId);
          throw cause;
        }
      }
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
      const enabled = await port.autoCompact();
      return Promise.all(
        agentIds.map(async (agentId): Promise<ContextStatus | null> => {
          await turnEnds.get(agentId);
          const state = sessions.get(agentId);
          let reading = state?.reading ?? null;
          let loop = state?.loop ?? false;
          if (!reading) {
            const agent = await port.readAgent(agentId);
            if (!agent) return null;
            reading = readContext(agent, thresholds);
            loop = countedStep(agent.labels) !== undefined;
          }
          const memory = state?.memory ?? { warned: [], mode: "normal", auto: "armed" };
          const auto = enabled && !loop && memory.mode !== "ignore" && memory.auto !== "skipped";
          return { agentId, reading, warned: [...memory.warned], mode: memory.mode, red: thresholds.red, auto };
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
        memory: { warned: [], mode: "normal", auto: "armed" },
        cursor: null,
        split: null,
        explore: null,
      };
      sessions.set(agentId, state);
      if (action === "skip-auto") state.memory.auto = "skipped";
      else state.memory.mode = action;
      await record(agentId, state, agent, action);
      return { ok: true, error: null, agentId };
    },
  };
}
