import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { GateAction } from "../shared/gates";
import type { ActResult } from "./context-watch";

// Gate actions (see CONTEXT.md, "Gate action"): the rules for acting on a story's gate from outside
// its session. Everything outside this file reaches it through GatePort.

export const APPROVE_MESSAGE = "Approved. Go ahead.";
export const NUDGE_MESSAGE = "You look stuck: say what's blocking you, or take a different approach.";

export type GateResult = { ok: boolean; error: string | null; agentId: string | null };

// What a gate action needs to know about a story.
export type GateStory = { status: string; agent: string | null; waitingOn: string | null };

export type StoryRef = { board: string; storyId: string };

export type GatePort = {
  // The story on that board, or null when it isn't there.
  story(ref: StoryRef): Promise<GateStory | null>;
  // Paseo knows the agent and it isn't archived.
  isLive(agentId: string): Promise<boolean>;
  send(agentId: string, text: string): Promise<void>;
  // Start fresh on the agent; `agentId` in the result is the new session.
  startFresh(agentId: string): Promise<GateResult>;
  // Back to `blocked_from`, with the block fields cleared.
  reopen(ref: StoryRef): Promise<void>;
};

// The gate each action belongs to: the status the story must still be at, and how a refusal names it.
const GATE_OF: Record<GateAction, { status: string; name: string }> = {
  approve: { status: "awaiting-approval", name: "awaiting approval" },
  changes: { status: "awaiting-approval", name: "awaiting approval" },
  nudge: { status: "blocked", name: "blocked" },
  restart: { status: "blocked", name: "blocked" },
};

const refuse = (error: string): GateResult => ({ ok: false, error, agentId: null });

export function createGateActions(port: GatePort) {
  return {
    async act({ board, storyId, action }: StoryRef & { action: GateAction }): Promise<GateResult> {
      const story = await port.story({ board, storyId });
      if (!story) return refuse(`${storyId} is not on that board.`);
      const gate = GATE_OF[action];
      if (story.status !== gate.status) return refuse(`${storyId} is now ${story.status}, not ${gate.name}.`);
      if (story.waitingOn === "permission") {
        return refuse(`${storyId} is waiting on a permission; answer it in the session.`);
      }
      const agentId = story.agent;
      if (!agentId || !(await port.isLive(agentId))) return refuse(`${storyId} has no live agent.`);
      switch (action) {
        case "approve":
          await port.send(agentId, APPROVE_MESSAGE);
          return { ok: true, error: null, agentId };
        case "changes":
          return { ok: true, error: null, agentId };
        case "nudge":
          await port.send(agentId, NUDGE_MESSAGE);
          await port.reopen({ board, storyId });
          return { ok: true, error: null, agentId };
        case "restart": {
          // The fresh adapter's own refusals (e.g. a turn still running) pass through unchanged.
          const fresh = await port.startFresh(agentId);
          if (!fresh.ok) return fresh;
          await port.reopen({ board, storyId });
          return fresh;
        }
      }
    },
  };
}

type PaseoApi = PluginHandlerContext["paseo"];

// The pieces of the initiative loop and the context watch the real port uses.
type LoopFiles = {
  gateStory(ref: { repo: string; initiative: string; storyId: string }): Promise<GateStory | null>;
  reopen(ref: { repo: string; initiative: string; storyId: string }): Promise<void>;
};
type FreshAct = { act(input: { agentId: string; action: "fresh" }): Promise<ActResult> };

// The board key is `repo + "\n" + initiative` (boardKey); null when it doesn't split.
function splitBoard(board: string): { repo: string; initiative: string } | null {
  const at = board.indexOf("\n");
  if (at <= 0 || at === board.length - 1) return null;
  return { repo: board.slice(0, at), initiative: board.slice(at + 1) };
}

// The real port. Restart calls the context watch directly, never through the loop's serial chain:
// the fresh adapter's handOver queues on that chain.
export function loopGatePort(loop: LoopFiles, paseo: PaseoApi, contextWatch: FreshAct): GatePort {
  return {
    async story({ board, storyId }) {
      const split = splitBoard(board);
      return split ? loop.gateStory({ ...split, storyId }) : null;
    },
    async isLive(agentId) {
      try {
        const refreshed = await paseo.agents.ref(agentId).refresh();
        return Boolean(refreshed && !refreshed.agent.archivedAt);
      } catch {
        return false;
      }
    },
    async send(agentId, text) {
      await paseo.agents.ref(agentId).send(text);
    },
    async startFresh(agentId) {
      const { ok, error, agentId: next } = await contextWatch.act({ agentId, action: "fresh" });
      return { ok, error, agentId: next };
    },
    async reopen({ board, storyId }) {
      const split = splitBoard(board);
      if (split) await loop.reopen({ ...split, storyId });
    },
  };
}
