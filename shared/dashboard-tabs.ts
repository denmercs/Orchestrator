export const TAB_IDS = ["initiatives", "today", "todos", "board", "pulse"] as const;

export type TabId = (typeof TAB_IDS)[number];

export const TABS: readonly { id: TabId; label: string }[] = [
  { id: "initiatives", label: "Initiatives" },
  { id: "today", label: "Today" },
  { id: "todos", label: "Todos" },
  { id: "board", label: "Board" },
  { id: "pulse", label: "Pulse" },
];
