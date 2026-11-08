import { existsSync, readFileSync } from "node:fs";
import { ROUND_NUDGE_AT, roundNudgeLine, shouldRoundNudge } from "../shared/round-nudge";
import type { LoopStep } from "../shared/story-method";
import { frontmatter, writeFrontmatter } from "./harness-layout";

const readText = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

/** Once per story when it first hits review round 3: record `round_nudged` and call `notify`. */
export function maybeRoundNudge(
  storyFile: string,
  storyId: string,
  title: string | null | undefined,
  step: LoopStep,
  round: number,
  factory: boolean,
  notify?: (line: string) => void,
): void {
  if (!existsSync(storyFile)) return;
  const meta = frontmatter(readText(storyFile));
  if (!shouldRoundNudge(step, round, meta, factory)) return;
  writeFrontmatter(storyFile, { round_nudged: String(ROUND_NUDGE_AT) });
  notify?.(roundNudgeLine(storyId, title));
}
