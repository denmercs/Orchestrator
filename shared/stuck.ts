import { exploration, toolSteps, type ToolItem } from "./exploration";

// Each `.harness/bin/brief` shell run in a turn that printed a test summary (`# tests N` or
// `ℹ tests N`), as the test names it failed. A passing run is []. Typecheck and lint runs have no
// summary and are skipped, as are commands that don't go through brief. Names come from the
// `not ok N - <name>` lines and the `✖ failing tests:` block that `pickLines` keeps. A failing run
// exits non-zero, which Claude reports as a failed tool call with the output on `error.content`.
export function testRuns(items: readonly ToolItem[]): string[][] {
  const runs: string[][] = [];
  for (const item of items) {
    const detail = item.detail;
    if (item.type !== "tool_call" || (item.status !== "completed" && item.status !== "failed") || detail?.type !== "shell") continue;
    const command = detail.command;
    const error = item.error as { content?: unknown } | null | undefined;
    const output = typeof detail.output === "string" ? detail.output : error?.content;
    if (typeof command !== "string" || typeof output !== "string" || !command.includes(".harness/bin/brief")) continue;
    const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
    if (!lines.some((line) => /^(#|ℹ) tests \d+/.test(line))) continue;
    const names: string[] = [];
    let inBlock = false;
    for (const line of lines) {
      const tap = /^\s*not ok \d+ - (.+)$/.exec(line);
      if (tap) names.push(tap[1].trim());
      if (line === "✖ failing tests:") inBlock = true;
      else if (inBlock && line.startsWith("✖ ")) names.push(line.slice(2).replace(/ \([\d.]+ms\)$/, "").trim());
    }
    runs.push([...new Set(names)]);
  }
  return runs;
}

export type StuckCounters = { idle_turns: number; fail_tests: string[]; fail_runs: number };

const FAIL_RUNS = 3;

// One completed turn's items against the story's carried counters: the next counters, and the
// evidence the step is stuck (null when it is not). Idle turns count on Implement only and not for
// subagent parents; the fail streak counts on every step. A failing test is named before idleness.
export function stuckCheck(
  counters: StuckCounters,
  items: readonly ToolItem[],
  { step, subagents, stuckTurns }: { step: string | null; subagents: boolean; stuckTurns: number },
): { counters: StuckCounters; evidence: string | null } {
  let { idle_turns, fail_tests, fail_runs } = counters;
  if (step === "implement" && !subagents) {
    idle_turns = exploration(toolSteps(items), { step }).edited ? 0 : idle_turns + 1;
  }
  for (const names of testRuns(items)) {
    if (names.length === 0) {
      fail_tests = [];
      fail_runs = 0;
      continue;
    }
    const shared = fail_runs === 0 ? names : fail_tests.filter((name) => names.includes(name));
    if (shared.length === 0) {
      fail_tests = names;
      fail_runs = 1;
    } else {
      fail_tests = shared;
      fail_runs += 1;
    }
  }
  let evidence: string | null = null;
  if (fail_runs >= FAIL_RUNS && fail_tests.length > 0) {
    const more = fail_tests.length > 1 ? ` (+${fail_tests.length - 1} more)` : "";
    evidence = `${fail_tests[0]} failed ${FAIL_RUNS} test runs in a row${more}`;
  } else if (step === "implement" && !subagents && idle_turns >= stuckTurns) {
    evidence = `no file edits in ${idle_turns} turns`;
  }
  return { counters: { idle_turns, fail_tests, fail_runs }, evidence };
}
