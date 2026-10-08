import { phaseLabel, type EpicBoard, type EpicStory } from "./orchestration";

// Where an agent is paused waiting on you: a plan to approve, a green PR to merge, or a blocked story.
export type GateKind = "plan" | "merge" | "stuck";

export type Gate = {
  kind: GateKind;
  // The board's selection key (boardKey), so a gate can open its story on the epic board.
  board: string;
  storyId: string;
  text: string;
  // Initiative title and phase label, e.g. "Orchestration Redesign · Phase 1".
  where: string;
};

// A board's identity, even when its state failed to load.
export const boardKey = (board: EpicBoard) => `${board.repo}\n${board.initiative}`;

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
      return [{ kind, board: boardKey(board), storyId: story.id, text: TEXT[kind](story), where }];
    });
  });
}

// The bell's label: how many gates are waiting on you.
export const waitingLabel = (count: number) => (count === 0 ? "Nothing is waiting on you" : `${count} waiting on you`);
