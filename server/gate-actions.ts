import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { GateAction } from "../shared/gates";
import type { ActResult } from "./context-watch";
import type { BlockKind } from "./initiative-loop";

// Gate actions (see CONTEXT.md, "Gate action"): the rules for acting on a story's gate from outside
// its session. Everything outside this file reaches it through GatePort.

export const APPROVE_MESSAGE = "Approved. Go ahead.";
export const NUDGE_MESSAGE = "You look stuck: say what's blocking you, or take a different approach.";
export const RETRY_MESSAGE =
  "The block on this step is cleared. Carry on from `.harness/state.md` and write the step's marker when you finish.";

export type GateResult = { ok: boolean; error: string | null; agentId: string | null };

// What a gate action needs to know about a story. `blockKind` is absent or null for a block that
// predates block kinds, and for a permission wait.
export type GateStory = { status: string; agent: string | null; waitingOn: string | null; blockKind?: BlockKind | null };

export type StoryRef = { board: string; storyId: string };

// An agent's session as a gate action sees it: `open` takes messages, `ended` (closed or errored) can
// only be started fresh, null is unknown or archived.
export type AgentSession = "open" | "ended" | null;

export type GatePort = {
  // The story on that board, or null when it isn't there.
  story(ref: StoryRef): Promise<GateStory | null>;
  session(agentId: string): Promise<AgentSession>;
  send(agentId: string, text: string): Promise<void>;
  // Start fresh on the agent; `agentId` in the result is the new session.
  startFresh(agentId: string): Promise<GateResult>;
  // Back to `blocked_from`, with the block fields cleared.
  reopen(ref: StoryRef): Promise<void>;
  // The loop starts the story's step again in a fresh session; `agentId` in the result is that session.
  retryStep(ref: StoryRef): Promise<GateResult>;
  // The story's PR number while that PR is closed; null when it isn't closed, or there is none.
  closedPr(ref: StoryRef): Promise<number | null>;
};

// The gate each action belongs to: the status the story must still be at, and how a refusal names it.
const GATE_OF: Record<GateAction, { status: string; name: string }> = {
  approve: { status: "awaiting-approval", name: "awaiting approval" },
  changes: { status: "awaiting-approval", name: "awaiting approval" },
  nudge: { status: "blocked", name: "blocked" },
  restart: { status: "blocked", name: "blocked" },
  retry: { status: "blocked", name: "blocked" },
};

// Blocks with no agent to wake: reopening is enough, and the loop picks the story up again.
const REOPEN_ONLY: ReadonlySet<BlockKind> = new Set(["start", "pr", "ci"]);

const refuse = (error: string): GateResult => ({ ok: false, error, agentId: null });

export function createGateActions(port: GatePort) {
  // Retry a blocked story by its block kind: reopen only, or wake its agent (a message to an open
  // session, the loop's fresh step for an ended or unknown one).
  async function retry(ref: StoryRef, story: GateStory): Promise<GateResult> {
    // A PR block whose PR is still closed would only block again on the next tick.
    if (story.blockKind === "pr") {
      const closed = await port.closedPr(ref);
      if (closed !== null) return refuse(`PR #${closed} is still closed; reopen it on GitHub, then retry ${ref.storyId}.`);
    }
    if ((story.blockKind && REOPEN_ONLY.has(story.blockKind)) || !story.agent) {
      await port.reopen(ref);
      return { ok: true, error: null, agentId: null };
    }
    if ((await port.session(story.agent)) !== "open") return port.retryStep(ref);
    if (story.waitingOn === "permission") {
      return refuse(`${ref.storyId} is waiting on a permission; answer it in the session.`);
    }
    // Reopen first: it sets the step's marker back to running before the agent can write its own.
    await port.reopen(ref);
    try {
      await port.send(story.agent, RETRY_MESSAGE);
    } catch (cause) {
      const why = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, error: `${ref.storyId} is unblocked, but its session didn't get the retry message: ${why}`, agentId: story.agent };
    }
    return { ok: true, error: null, agentId: story.agent };
  }

  return {
    async act({ board, storyId, action }: StoryRef & { action: GateAction }): Promise<GateResult> {
      const story = await port.story({ board, storyId });
      if (!story) return refuse(`${storyId} is not on that board.`);
      const gate = GATE_OF[action];
      if (story.status !== gate.status) return refuse(`${storyId} is now ${story.status}, not ${gate.name}.`);
      if (action === "retry") return retry({ board, storyId }, story);
      if (story.waitingOn === "permission") {
        return refuse(`${storyId} is waiting on a permission; answer it in the session.`);
      }
      const agentId = story.agent;
      const session = agentId ? await port.session(agentId) : null;
      // Start fresh can carry on from an ended session; a message can't reach one.
      const live = session === "open" || (session === "ended" && action === "restart");
      if (!agentId || !live) return refuse(`${storyId} has no live agent.`);
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
  retryStep(api: PaseoApi, ref: { repo: string; initiative: string; storyId: string }): Promise<GateResult>;
  closedPr(ref: { repo: string; initiative: string; storyId: string }): Promise<number | null>;
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
    async session(agentId) {
      try {
        const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
        if (!agent || agent.archivedAt) return null;
        return agent.status === "closed" || agent.status === "error" ? "ended" : "open";
      } catch {
        return null;
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
    async retryStep({ board, storyId }) {
      const split = splitBoard(board);
      return split ? loop.retryStep(paseo, { ...split, storyId }) : refuse(`${storyId} is not on that board.`);
    },
    async closedPr({ board, storyId }) {
      const split = splitBoard(board);
      return split ? loop.closedPr({ ...split, storyId }) : null;
    },
  };
}
