import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { phaseLabel, type EpicBoard, type EpicStory } from "./orchestration";

// Where an agent is paused waiting on you: a plan to approve, a green PR to merge, or a blocked story.
export type GateKind = "plan" | "merge" | "stuck";

export type Gate = {
  kind: GateKind;
  // The board's selection key (boardKey), so a gate can open its story on the epic board.
  board: string;
  storyId: string;
  // The story's title.
  title: string;
  text: string;
  // Initiative title and phase label, e.g. "Orchestration Redesign · Phase 1".
  where: string;
  // The PR on the repo for a merge gate; "" when there is no PR or no repoUrl.
  prUrl: string;
};

// A board's identity, even when its state failed to load.
export const boardKey = (board: Pick<EpicBoard, "repo" | "initiative">) => `${board.repo}\n${board.initiative}`;

function gateKind(story: EpicStory): GateKind | null {
  if (story.status === "awaiting-approval") return "plan";
  if (story.status === "pr-open" && story.ci === "green") return "merge";
  if (story.status === "blocked") return "stuck";
  return null;
}

const TEXT: Record<GateKind, (story: EpicStory) => string> = {
  plan: () => "Plan awaiting approval",
  merge: (story) => (story.pr === null ? "PR ready to merge" : `PR #${story.pr} ready to merge`),
  stuck: (story) => story.blockedReason || "Blocked",
};

// A story waits on you when its plan needs approval, it is blocked, or its PR is green and ready to merge.
export const needsYou = (story: EpicStory) => gateKind(story) !== null;

// Every gate across the boards, in board order then story order. Boards with no state have none.
export function gatesOf(boards: EpicBoard[]): Gate[] {
  return boards.flatMap((board) => {
    const state = board.state;
    if (!state) return [];
    const where = `${state.initiative} · ${phaseLabel(state.epic.id)}`;
    return state.stories.flatMap((story) => {
      const kind = gateKind(story);
      if (!kind) return [];
      const prUrl = kind === "merge" && story.pr !== null && state.repoUrl ? `${state.repoUrl}/pull/${story.pr}` : "";
      return [
        { kind, board: boardKey(board), storyId: story.id, title: story.title, text: TEXT[kind](story), where, prUrl },
      ];
    });
  });
}

// The bell's label: how many gates are waiting on you.
export const waitingLabel = (count: number) => (count === 0 ? "Nothing is waiting on you" : `${count} waiting on you`);

// A gate row's accessibility label: what is waiting, then where.
export const gateRowLabel = (gate: Gate) => `${gate.text}, ${gate.where}`;

// What you can do to a gate from outside the session: approve or request changes on a plan gate,
// nudge, restart or retry a stuck one (see CONTEXT.md, "Gate action").
export const GATE_ACTIONS = ["approve", "changes", "nudge", "restart", "retry"] as const;
export type GateAction = (typeof GATE_ACTIONS)[number];

// One gate action on a story. `board` is the board key (boardKey). `agentId` in the output is the
// story's agent, the new session after `restart` or a fresh `retry`, or null after a reopen-only `retry`.
export const gateAct = defineRpc({
  name: "orchestration.gates.act",
  input: z.object({ board: z.string(), storyId: z.string(), action: z.enum(GATE_ACTIONS) }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    agentId: z.string().nullable(),
  }),
});

// A button on a needs-you row: a gate action (sent through gateAct), or "open-pr", which opens `url`.
export type GateRowAction = { kind: GateAction | "open-pr"; label: string; url?: string };

// One row of the needs-you queue: which story, what waits, where, and what you can do about it.
export type GateRow = {
  tag: string;
  text: string;
  where: string;
  primary: GateRowAction;
  secondary: GateRowAction | null;
};

const ROW_ACTIONS: Record<GateKind, (gate: Gate) => Pick<GateRow, "primary" | "secondary">> = {
  plan: () => ({
    primary: { kind: "approve", label: "Approve plan" },
    secondary: { kind: "changes", label: "Request changes" },
  }),
  stuck: () => ({
    primary: { kind: "restart", label: "Restart from handoff" },
    secondary: { kind: "nudge", label: "Nudge" },
  }),
  merge: (gate) => ({ primary: { kind: "open-pr", label: "Review & merge", url: gate.prUrl }, secondary: null }),
};

export const gateRow = (gate: Gate): GateRow => ({
  tag: gate.storyId,
  text: `${gate.title}: ${gate.text}`,
  where: gate.where,
  ...ROW_ACTIONS[gate.kind](gate),
});
