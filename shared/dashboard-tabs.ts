import type { EpicBoard, JiraIssue, ProdPulse } from "./orchestration";

export const TAB_IDS = ["initiatives", "today", "todos", "board", "pulse"] as const;

export type TabId = (typeof TAB_IDS)[number];

export const TABS: readonly { id: TabId; label: string }[] = [
  { id: "initiatives", label: "Initiatives" },
  { id: "today", label: "Today" },
  { id: "todos", label: "Todos" },
  { id: "board", label: "Board" },
  { id: "pulse", label: "Pulse" },
];

// Each source is null while it hasn't loaded.
export type TabCountsInput = {
  boards: readonly EpicBoard[] | null;
  sprintIssues: readonly JiraIssue[] | null;
  pulse: Pick<ProdPulse, "available" | "issues" | "older"> | null;
};

export function tabCounts(input: TabCountsInput): Record<TabId, number | null> {
  const { boards, sprintIssues, pulse } = input;
  return {
    initiatives: boards?.length ?? null,
    today: null,
    todos: null,
    board: sprintIssues?.length ?? null,
    pulse: pulse?.available ? pulse.issues.length + pulse.older.length : null,
  };
}
