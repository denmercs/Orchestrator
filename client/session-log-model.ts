// The story drawer's log: one page of an agent's timeline (paseo.agents.ref(id).timeline.refetch)
// turned into short lines, and the pages merged as the tail refreshes and older pages load.
// Kept free of React and the Paseo client so it can be tested on its own.

import { STEP_LABELS, type LoopStep } from "../shared/initiative-loop";

// The parts of a Paseo agent snapshot the log reads.
export type LogSession = { id: string; title: string | null; workspaceId?: string; labels?: Record<string, string> };

// Story ids can repeat across an initiative's phases; the story's own workspace pins it down.
// Without a workspace (not started yet) every listed session counts.
export function storySessions<T extends LogSession>(agents: T[], workspace: string): T[] {
  return workspace ? agents.filter((agent) => agent.workspaceId === workspace) : agents;
}

// "Plan", "Review 2", "Fix CI 3": the step the loop started this session for, and its round.
export function stepTitle(agent: LogSession) {
  const step = agent.labels?.["loop-step"];
  const round = Number(agent.labels?.["loop-round"]) || 1;
  const label = (step && Object.hasOwn(STEP_LABELS, step) ? STEP_LABELS[step as LoopStep] : "") || agent.title || agent.id;
  return round > 1 ? `${label} ${round}` : label;
}

export type LogItem =
  | { type: "user_message"; text: string }
  | { type: "assistant_message"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; name: string; status: string; detail: Record<string, unknown> & { type: string }; error: unknown }
  | { type: "todo"; items: { text: string; completed: boolean }[] }
  | { type: "error"; message: string }
  | { type: "notification"; level: string; message: string }
  | { type: "compaction"; status: string }
  | { type: "plugin"; kind: string };

export type LogEntry = { item: { type: string }; timestamp: string; seqStart: number; seqEnd: number };

export type LogPage = {
  epoch: string;
  entries: LogEntry[];
  startCursor: { epoch: string; seq: number } | null;
  hasOlder: boolean;
};

export type LogLine = {
  key: string;
  kind: "prompt" | "reply" | "thinking" | "tool" | "todo" | "error" | "note";
  // One line for the row; `body` is what expanding it shows (empty when there is nothing more).
  title: string;
  body: string;
  failed: boolean;
  timestamp: string;
};

const str = (value: unknown) => (typeof value === "string" ? value : "");

function firstLine(text: string) {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

// What a tool call did, in one line: the command, file, query or URL it touched.
function toolSummary(detail: Record<string, unknown> & { type: string }) {
  switch (detail.type) {
    case "shell":
      return str(detail.command);
    case "read":
    case "edit":
    case "write":
      return str(detail.filePath);
    case "search":
      return str(detail.query);
    case "fetch":
      return str(detail.url);
    case "sub_agent":
      return str(detail.description) || str(detail.subAgentType);
    case "plain_text":
      return str(detail.label) || str(detail.text);
    case "worktree_setup":
      return str(detail.branchName);
    default:
      return "";
  }
}

function toolBody(detail: Record<string, unknown> & { type: string }, error: unknown) {
  const parts = [
    str(detail.output),
    str(detail.unifiedDiff),
    str(detail.content),
    str(detail.result),
    str(detail.log),
    str(detail.text),
  ].filter(Boolean);
  if (error) parts.push(typeof error === "string" ? error : JSON.stringify(error));
  return parts.join("\n\n");
}

export function logLine(entry: LogEntry): LogLine | null {
  const item = entry.item as LogItem;
  const base = { key: `${entry.seqStart}`, timestamp: entry.timestamp, failed: false };
  switch (item.type) {
    case "user_message":
      return { ...base, kind: "prompt", title: firstLine(item.text), body: item.text };
    case "assistant_message":
      return { ...base, kind: "reply", title: firstLine(item.text), body: item.text };
    case "reasoning":
      return { ...base, kind: "thinking", title: firstLine(item.text), body: item.text };
    case "tool_call": {
      const summary = toolSummary(item.detail);
      return {
        ...base,
        kind: "tool",
        title: summary ? `${item.name} · ${firstLine(summary)}` : item.name,
        body: toolBody(item.detail, item.error),
        failed: item.status === "failed",
      };
    }
    case "todo": {
      const done = item.items.filter((task) => task.completed).length;
      return {
        ...base,
        kind: "todo",
        title: `Tasks ${done}/${item.items.length}`,
        body: item.items.map((task) => `${task.completed ? "✓" : "○"} ${task.text}`).join("\n"),
      };
    }
    case "error":
      return { ...base, kind: "error", title: firstLine(item.message), body: item.message, failed: true };
    case "notification":
      return { ...base, kind: item.level === "error" ? "error" : "note", title: firstLine(item.message), body: item.message, failed: item.level === "error" };
    case "compaction":
      return item.status === "completed" ? { ...base, kind: "note", title: "Context compacted", body: "" } : null;
    default:
      return null;
  }
}

export type LogState = {
  epoch: string;
  entries: LogEntry[];
  // Where "Load earlier" continues from, and whether there is anything there.
  olderCursor: { epoch: string; seq: number } | null;
  hasOlder: boolean;
};

// A fresh tail replaces everything from its first entry on and keeps the older pages before it.
// A new epoch means the daemon rewrote the timeline, and a tail that starts past what we hold
// would leave a hole, so both start over from the tail ("Load earlier" fills in from there).
export function mergeTail(current: LogState | null, tail: LogPage): LogState {
  const first = tail.entries[0]?.seqStart ?? Number.POSITIVE_INFINITY;
  if (!current || current.epoch !== tail.epoch || !current.entries.length) {
    return { epoch: tail.epoch, entries: tail.entries, olderCursor: tail.startCursor, hasOlder: tail.hasOlder };
  }
  const last = current.entries[current.entries.length - 1].seqEnd;
  const kept = current.entries.filter((entry) => entry.seqEnd < first);
  if (!kept.length || first > last + 1) {
    return { epoch: tail.epoch, entries: tail.entries, olderCursor: tail.startCursor, hasOlder: tail.hasOlder };
  }
  return { ...current, entries: [...kept, ...tail.entries] };
}

// An older page goes in front; entries the state already holds are skipped.
export function mergeOlder(current: LogState, page: LogPage): LogState {
  if (page.epoch !== current.epoch) return current;
  const first = current.entries[0]?.seqStart ?? Number.POSITIVE_INFINITY;
  const older = page.entries.filter((entry) => entry.seqEnd < first);
  return { ...current, entries: [...older, ...current.entries], olderCursor: page.startCursor, hasOlder: page.hasOlder };
}
