import { exploration, toolSteps, type ToolItem } from "./exploration";

// The failing test names in one brief log: null when it has no test summary line (typecheck, lint),
// otherwise the de-duplicated names, [] when it passed.
export function briefTestFailures(output: string): string[] | null {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  if (!lines.some((line) => /^(#|ℹ) tests \d+/.test(line))) return null;
  const names: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const tap = /^\s*not ok \d+ - (.+)$/.exec(line);
    if (tap) names.push(tap[1].trim());
    if (line === "✖ failing tests:") inBlock = true;
    else if (inBlock && line.startsWith("✖ ")) names.push(line.slice(2).replace(/ \([\d.]+ms\)$/, "").trim());
  }
  return [...new Set(names)];
}

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
    const names = briefTestFailures(output);
    if (names) runs.push(names);
  }
  return runs;
}

export type StuckCounters = { idle_turns: number; fail_tests: string[]; fail_runs: number };

const FAIL_RUNS = 3;

// The shared-failure streak: each run's failing names fold into the carried streak. A pass resets it;
// a run sharing no name with the streak restarts it.
function foldRuns(streak: { fail_tests: string[]; fail_runs: number }, runs: readonly string[][]): { fail_tests: string[]; fail_runs: number } {
  let { fail_tests, fail_runs } = streak;
  for (const names of runs) {
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
  return { fail_tests, fail_runs };
}

function failEvidence(fail_tests: string[], fail_runs: number): string | null {
  if (fail_runs < FAIL_RUNS || fail_tests.length === 0) return null;
  const more = fail_tests.length > 1 ? ` (+${fail_tests.length - 1} more)` : "";
  return `${fail_tests[0]} failed ${FAIL_RUNS} test runs in a row${more}`;
}

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
  ({ fail_tests, fail_runs } = foldRuns({ fail_tests, fail_runs }, testRuns(items)));
  let evidence = failEvidence(fail_tests, fail_runs);
  if (evidence === null && step === "implement" && !subagents && idle_turns >= stuckTurns) {
    evidence = `no file edits in ${idle_turns} turns`;
  }
  return { counters: { idle_turns, fail_tests, fail_runs }, evidence };
}

export const MID_TURN_IDLE_MS = 20 * 60_000;

export type MidTurn = { fingerprint: string | null; changed: string | null };

// The running turn's progress read from disk: the test runs since the turn started (failing names,
// [] = pass), the worktree fingerprint now (null = unknown) and the carried fingerprint state.
// Returns the next state, the stuck evidence (null when none) and whether the step made progress
// (a passing last run or a changed fingerprint, with no evidence). A failing test is named before
// idleness; idleness counts on Implement only and not for subagent parents. A brief run still going
// (`testRunning`) isn't idle, and the last finished run (`lastRunMs`, pass or fail) restarts the idle clock.
export function midTurnCheck({ runs, fingerprint, now, mid, step, subagents, testRunning, lastRunMs }: {
  runs: readonly string[][];
  fingerprint: string | null;
  now: number;
  mid: MidTurn;
  step: string | null;
  subagents: boolean;
  testRunning: boolean;
  lastRunMs: number | null;
}): { mid: MidTurn; evidence: string | null; progressed: boolean } {
  const streak = foldRuns({ fail_tests: [], fail_runs: 0 }, runs);
  let progressed = runs.length > 0 && runs[runs.length - 1].length === 0;
  let next = mid;
  if (fingerprint !== null && fingerprint !== mid.fingerprint) {
    next = { fingerprint, changed: new Date(now).toISOString() };
    if (mid.fingerprint !== null) progressed = true;
  }
  let evidence = failEvidence(streak.fail_tests, streak.fail_runs);
  const activeMs = Math.max(Date.parse(next.changed ?? ""), lastRunMs ?? -Infinity);
  if (evidence === null && fingerprint !== null && step === "implement" && !subagents && next.changed !== null
    && fingerprint === mid.fingerprint && !testRunning && now - activeMs >= MID_TURN_IDLE_MS) {
    evidence = `no file edits in ${MID_TURN_IDLE_MS / 60_000} minutes`;
  }
  // As at a turn end, an edit doesn't excuse a test that keeps failing.
  return { mid: next, evidence, progressed: progressed && evidence === null };
}
