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

// What the turns of a failing-test streak edited: "code" once any turn edited a file that is neither a test nor under
// `.harness/`, else "tests" once any edited a test or `.harness/` file, else "none".
export type FailEdits = "none" | "tests" | "code";

// `ceremony_turns` counts completed turns in a row that edited only `.harness/` files.
export type StuckCounters = { idle_turns: number; fail_tests: string[]; fail_runs: number; ceremony_turns: number; fail_edits: FailEdits };

const FAIL_RUNS = 3;

// The shared-failure streak: each run's failing names fold into the carried streak. A pass resets it;
// a run sharing no name with the streak restarts it. `restarted` is true when either happened during the fold,
// so the streak left standing began inside these runs rather than carrying on from before.
function foldRuns(
  streak: { fail_tests: string[]; fail_runs: number },
  runs: readonly string[][],
): { fail_tests: string[]; fail_runs: number; restarted: boolean } {
  let { fail_tests, fail_runs } = streak;
  let restarted = false;
  for (const names of runs) {
    if (names.length === 0) {
      fail_tests = [];
      fail_runs = 0;
      restarted = true;
      continue;
    }
    const shared = fail_runs === 0 ? names : fail_tests.filter((name) => names.includes(name));
    if (shared.length === 0) {
      fail_tests = names;
      fail_runs = 1;
      restarted = true;
    } else {
      fail_tests = shared;
      fail_runs += 1;
    }
  }
  return { fail_tests, fail_runs, restarted };
}

function failEvidence(fail_tests: string[], fail_runs: number, fail_edits: FailEdits = "code"): string | null {
  if (fail_runs < FAIL_RUNS || fail_tests.length === 0) return null;
  const more = fail_tests.length > 1 ? ` (+${fail_tests.length - 1} more)` : "";
  const checks = fail_edits === "tests" ? ", and every turn edited only tests or .harness files, not the code under test" : "";
  return `${fail_tests[0]} failed ${FAIL_RUNS} test runs in a row${more}${checks}`;
}

const inHarness = (path: string) => path.split(/[\\/]/).includes(".harness");
const isTestFile = (path: string) => /\.(test|spec)\.[^\\/]+$/.test(path) || /(^|[\\/])(test|__tests__)[\\/]/.test(path);

// Which kinds of file a turn's edits and writes touched: product code (neither a test nor under
// `.harness/`), a test file, or a file under `.harness/`.
function editedFiles(items: readonly ToolItem[]): { code: boolean; test: boolean; harness: boolean } {
  const touched = { code: false, test: false, harness: false };
  for (const step of toolSteps(items)) {
    if (step.kind !== "edit" && step.kind !== "write") continue;
    for (const path of step.paths) {
      if (inHarness(path)) touched.harness = true;
      else if (isTestFile(path)) touched.test = true;
      else touched.code = true;
    }
  }
  return touched;
}

const RANK: Record<FailEdits, number> = { none: 0, tests: 1, code: 2 };

// Steps that legitimately write only `.harness/` files over several turns: the ceremony signal skips them.
const CEREMONY_EXEMPT = new Set(["plan", "diagnose"]);

// One completed turn's items against the story's carried counters: the next counters, and the
// evidence the step is stuck (null when it is not). Idle turns count on Implement only and not for
// subagent parents; the fail streak counts on every step. A failing test is named before idleness.
// Two more signals run on every step but Plan and Diagnose: ceremony turns (`stuckTurns` completed
// turns in a row that edit only `.harness/` files; a turn with no edits neither counts nor resets,
// and an edit outside `.harness/` resets) and checks instead of a fix (the fail streak, whose turns
// all edited only tests or `.harness/` files, which the evidence says).
export function stuckCheck(
  counters: StuckCounters,
  items: readonly ToolItem[],
  { step, subagents, stuckTurns }: { step: string | null; subagents: boolean; stuckTurns: number },
): { counters: StuckCounters; evidence: string | null } {
  let { idle_turns, fail_tests, fail_runs, ceremony_turns, fail_edits } = counters;
  if (step === "implement" && !subagents) {
    idle_turns = exploration(toolSteps(items), { step }).edited ? 0 : idle_turns + 1;
  }
  const edited = editedFiles(items);
  const streakBefore = fail_runs;
  const folded = foldRuns({ fail_tests, fail_runs }, testRuns(items));
  ({ fail_tests, fail_runs } = folded);
  // A streak that began or restarted this turn starts from this turn's edits; a longer one keeps the larger of the two.
  const turnEdits: FailEdits = edited.code ? "code" : edited.test || edited.harness ? "tests" : "none";
  const fresh = streakBefore === 0 || folded.restarted;
  fail_edits = fail_runs === 0 ? "none" : fresh || RANK[turnEdits] > RANK[fail_edits] ? turnEdits : fail_edits;
  if (edited.code || edited.test) ceremony_turns = 0;
  else if (edited.harness) ceremony_turns += 1;
  let evidence = failEvidence(fail_tests, fail_runs, fail_edits);
  if (evidence === null && step === "implement" && !subagents && idle_turns >= stuckTurns) {
    evidence = `no file edits in ${idle_turns} turns`;
  }
  if (evidence === null && !CEREMONY_EXEMPT.has(step ?? "") && ceremony_turns >= stuckTurns) {
    evidence = `${ceremony_turns} turns in a row edited only .harness files`;
  }
  return { counters: { idle_turns, fail_tests, fail_runs, ceremony_turns, fail_edits }, evidence };
}

export const MID_TURN_IDLE_MS = 20 * 60_000;

// Past this a running command no longer counts as activity: a brief run reads as idle again, and a
// tool call still going is stuck.
export const RUN_CAP_MS = 60 * 60_000;

export type TimelineEntry = { item: ToolItem; timestamp: string; turnId?: string };

// When the oldest tool call still running in the turn started, from a page of timeline entries (a
// running call's entry keeps its start time). Null when none is running. Entries from another turn
// are skipped.
export function toolRunningSince(entries: readonly TimelineEntry[], turnId: string): number | null {
  let since: number | null = null;
  for (const entry of entries) {
    if (entry.item?.type !== "tool_call" || entry.item.status !== "running") continue;
    if (entry.turnId !== undefined && entry.turnId !== turnId) continue;
    const ms = Date.parse(entry.timestamp);
    if (!Number.isNaN(ms) && (since === null || ms < since)) since = ms;
  }
  return since;
}

export type MidTurn = { fingerprint: string | null; changed: string | null };

// The running turn's progress read from disk: the test runs since the turn started (failing names,
// [] = pass), the worktree fingerprint now (null = unknown) and the carried fingerprint state.
// Returns the next state, the stuck evidence (null when none), whether the step made progress
// (a passing last run or a changed fingerprint, with no evidence) and whether to block and interrupt
// now. A failing test is named before idleness; idleness counts on Implement only and not for
// subagent parents. A brief run still going (`testRunning`) or a tool call running under RUN_CAP_MS
// (`toolRunningSinceMs`, null = unknown) isn't idle, and the last finished run (`lastRunMs`, pass or
// fail) restarts the idle clock. A call past the cap is stuck inside it, where a steer can't land, so
// it skips the nudge (`interrupt`).
export function midTurnCheck({ runs, fingerprint, now, mid, step, subagents, testRunning, lastRunMs, toolRunningSinceMs }: {
  runs: readonly string[][];
  fingerprint: string | null;
  now: number;
  mid: MidTurn;
  step: string | null;
  subagents: boolean;
  testRunning: boolean;
  lastRunMs: number | null;
  toolRunningSinceMs: number | null;
}): { mid: MidTurn; evidence: string | null; progressed: boolean; interrupt: boolean } {
  const streak = foldRuns({ fail_tests: [], fail_runs: 0 }, runs);
  let progressed = runs.length > 0 && runs[runs.length - 1].length === 0;
  let next = mid;
  if (fingerprint !== null && fingerprint !== mid.fingerprint) {
    next = { fingerprint, changed: new Date(now).toISOString() };
    if (mid.fingerprint !== null) progressed = true;
  }
  const idleWatch = step === "implement" && !subagents;
  if (idleWatch && toolRunningSinceMs !== null && now - toolRunningSinceMs >= RUN_CAP_MS) {
    return { mid: next, evidence: `one command running over ${RUN_CAP_MS / 60_000} minutes`, progressed: false, interrupt: true };
  }
  const running = testRunning || toolRunningSinceMs !== null;
  let evidence = failEvidence(streak.fail_tests, streak.fail_runs);
  const activeMs = Math.max(Date.parse(next.changed ?? ""), lastRunMs ?? -Infinity);
  if (evidence === null && fingerprint !== null && idleWatch && next.changed !== null
    && fingerprint === mid.fingerprint && !running && now - activeMs >= MID_TURN_IDLE_MS) {
    evidence = `no file edits in ${MID_TURN_IDLE_MS / 60_000} minutes`;
  }
  // As at a turn end, an edit doesn't excuse a test that keeps failing.
  return { mid: next, evidence, progressed: progressed && evidence === null, interrupt: false };
}
