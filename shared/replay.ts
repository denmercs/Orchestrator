// Pure helpers for the memory replay: which brief each arm gets. Also the judge outcome, the queue and cap planning, and the RPC contract.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { briefFor, type Memory } from "./memory";

export type Arm = "none" | "facts" | "facts+corrections";

export const ARMS: Arm[] = ["none", "facts", "facts+corrections"];

// The brief a replayed Review gets in one arm: none, facts and decisions only, or everything `briefFor` offers.
export function armBrief(memory: Memory, arm: Arm, paths: string[]): string[] {
  if (arm === "none") return [];
  const source = arm === "facts" ? { ...memory, notes: memory.notes.filter((n) => n.type !== "correction") } : memory;
  return briefFor(source, { step: "review", paths }, 15);
}

export type Match = [replayIdx: number, recordedIdx: number];
export type JudgeVerdict = { matches: Match[]; new: number[] };
export type Outcome = { caught: string[]; notCaught: string[]; new: string[] };

function isIndex(v: unknown, limit: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v < limit;
}

// Reads the judge's reply (bare or in a ```json fence). Null when it is not the agreed shape or an index is out of range.
export function parseJudge(reply: string, nReplay: number, nRecorded: number): JudgeVerdict | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(reply);
  let data: unknown;
  try {
    data = JSON.parse((fenced ? fenced[1] : reply).trim());
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { matches, new: fresh } = data as { matches?: unknown; new?: unknown };
  if (!Array.isArray(matches) || !Array.isArray(fresh)) return null;
  const pairs: Match[] = [];
  for (const m of matches) {
    if (!Array.isArray(m) || m.length !== 2 || !isIndex(m[0], nReplay) || !isIndex(m[1], nRecorded)) return null;
    pairs.push([m[0], m[1]]);
  }
  if (!fresh.every((i) => isIndex(i, nReplay))) return null;
  return { matches: pairs, new: fresh as number[] };
}

// Recorded findings the replay caught or missed, and replay findings that matched nothing recorded. Null when the judge gave no matches.
export function outcomeOf(recorded: string[], replay: string[], matches: Match[] | null): Outcome | null {
  if (!matches) return null;
  const caughtIdx = new Set(matches.map((m) => m[1]));
  const matchedReplay = new Set(matches.map((m) => m[0]));
  return {
    caught: recorded.filter((_, i) => caughtIdx.has(i)),
    notCaught: recorded.filter((_, i) => !caughtIdx.has(i)),
    new: replay.filter((_, i) => !matchedReplay.has(i)),
  };
}

// One yes/no checklist line per new finding, for a human to judge in S8.
export function newFindingsLines(row: { story: string; round: number; arm: Arm; outcome: Outcome | null }): string[] {
  return (row.outcome?.new ?? []).map((f) => `- [ ] yes / no — ${row.story} r${row.round} ${row.arm}: ${f}`);
}

export type CorpusRow = {
  initiative: string;
  story: string;
  title: string;
  // The story file without frontmatter and `## Outcome`, as the loop's Review prompt carries it.
  body: string;
  round: number;
  kind: "failed" | "control";
  commit: string;
  base: string;
  asOf: string;
  findings: string[];
  plan: string;
  cycles: string;
};

// Identity of one (round, arm) pair, as kept in the done set. Ids repeat across initiatives, so the initiative is part of it.
export function pairKey(row: Pick<CorpusRow, "initiative" | "story" | "round">, arm: Arm): string {
  return `${row.initiative}/${row.story}#${row.round}:${arm}`;
}

export type QueuedRound = { row: CorpusRow; arms: Arm[] };

// Rounds still to run, failed and control alternating (failed first). Done pairs are skipped; a round with no arms left is dropped.
export function replayQueue(corpus: CorpusRow[], done: ReadonlySet<string>): QueuedRound[] {
  const failed = corpus.filter((r) => r.kind === "failed");
  const control = corpus.filter((r) => r.kind === "control");
  const queue: QueuedRound[] = [];
  for (let i = 0; i < Math.max(failed.length, control.length); i++) {
    for (const row of [failed[i], control[i]]) {
      if (!row) continue;
      const arms = ARMS.filter((arm) => !done.has(pairKey(row, arm)));
      if (arms.length) queue.push({ row, arms });
    }
  }
  return queue;
}

// True when a round of `arms` agents, each reserved at `reserve` dollars, still fits under the cap.
export function fits(spent: number, reserve: number, cap: number, arms: number): boolean {
  return spent + arms * reserve <= cap + 1e-9;
}

// Starts the replay over `<root>/.harness/replay/corpus.jsonl`. It returns once the run has started; progress is in
// `<root>/.harness/replay/<run>/run.log` and `results.jsonl`. `costCap` overrides the default cap, `controls` limits the control rounds.
export const startMemoryReplay = defineRpc({
  name: "orchestration.replay.start",
  input: z.object({
    root: z.string().min(1),
    costCap: z.number().positive().optional(),
    controls: z.number().int().min(0).optional(),
  }),
  output: z.object({ run: z.string(), rounds: z.number(), costCap: z.number(), runDir: z.string() }),
});
