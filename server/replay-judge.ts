// The replay judge: Claude Haiku decides which replayed Review findings match the recorded ones.
import { type Ask, claudeCli } from "./claude-cli";
import { type Match, parseJudge } from "./replay";

// `reply` carries the raw text when it could not be read, so a run can show why a row has no outcome.
export type Judge = (recorded: string[], replay: string[]) => Promise<{ matches: Match[] | null; costUsd: number; reply?: string }>;

const SYSTEM = [
  "You compare two lists of code review findings: RECORDED (what a past review found) and REPLAY (what a replayed review found).",
  "A replay finding matches a recorded finding when both point at the same underlying problem, even if worded differently.",
  'Answer with JSON only, no prose and no code fence: {"matches":[[<replay index>,<recorded index>]],"new":[<replay index>]}.',
  'Indexes are 0-based. "new" lists the replay findings that match no recorded finding.',
].join("\n");

const list = (title: string, items: string[]) => `${title}:\n${items.map((f, i) => `[${i}] ${f}`).join("\n") || "(none)"}`;

export function haikuJudge(ask: Ask = claudeCli()): Judge {
  return async (recorded, replay) => {
    // An unusable reply was still billed: report the cost with no verdict.
    const { text, costUsd } = await ask(SYSTEM, `${list("RECORDED", recorded)}\n\n${list("REPLAY", replay)}`);
    const verdict = parseJudge(text, replay.length, recorded.length);
    return verdict ? { matches: verdict.matches, costUsd } : { matches: null, costUsd, reply: text };
  };
}
