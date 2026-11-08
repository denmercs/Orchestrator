import type { ToolItem } from "../shared/exploration";
import { stuckCheck, type StuckCounters } from "../shared/stuck";
import { writeFrontmatter } from "./harness-layout";

// This turn's items: those after the last user message.
export function turnItems(timeline: readonly unknown[] | undefined): readonly ToolItem[] {
  const items = (timeline ?? []) as readonly ToolItem[];
  return items.slice(items.map((item) => item.type).lastIndexOf("user_message") + 1);
}

// The counters a story carries in its frontmatter; an unreadable list restarts the streak.
function carried(meta: Record<string, string>): StuckCounters {
  let failTests: string[] = [];
  try {
    const parsed: unknown = JSON.parse(meta.fail_tests || "[]");
    if (Array.isArray(parsed)) failTests = parsed.filter((name): name is string => typeof name === "string");
  } catch {
    // an unreadable list restarts the streak
  }
  return {
    idle_turns: Number(meta.idle_turns) || 0,
    fail_tests: failTests,
    fail_runs: Number(meta.fail_runs) || 0,
    ceremony_turns: Number(meta.ceremony_turns) || 0,
    fail_edits: meta.fail_edits === "tests" || meta.fail_edits === "code" ? meta.fail_edits : "none",
  };
}

// One completed turn against the story's carried counters: the next counters go back to its frontmatter (and a nudge
// that progress has answered is cleared), and the stuck evidence comes back, null when the step is not stuck. The loop's
// supervised steps and a factory slice's seats both run their turn ends through here.
export function carryStuck(
  file: string,
  meta: Record<string, string>,
  items: readonly ToolItem[],
  options: { step: string | null; subagents: boolean; stuckTurns: number },
): string | null {
  const { counters, evidence } = stuckCheck(carried(meta), items, options);
  writeFrontmatter(file, {
    idle_turns: counters.idle_turns || null,
    fail_tests: counters.fail_tests.length ? JSON.stringify(counters.fail_tests) : null,
    fail_runs: counters.fail_runs || null,
    ceremony_turns: counters.ceremony_turns || null,
    fail_edits: counters.fail_edits === "none" ? null : counters.fail_edits,
    ...(!evidence && meta.stuck_nudged ? { stuck_nudged: null } : {}),
  });
  return evidence;
}
