import { existsSync, readFileSync } from "node:fs";
import { ROUND_NUDGE_AT, roundNudgeDue } from "../shared/round-nudge";
import { frontmatter, writeFrontmatter } from "./harness-layout";

const readText = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

/**
 * Once per story from review round 3: send `line`, and record `round_nudged` only when `send` says it reached
 * someone. A refusal or a throw leaves the nudge pending, so the next tick tries again.
 */
export async function maybeRoundNudge(
  storyFile: string,
  reviewRound: number,
  line: string,
  send: (line: string) => boolean | Promise<boolean>,
): Promise<void> {
  if (!existsSync(storyFile)) return;
  if (!roundNudgeDue(frontmatter(readText(storyFile)), reviewRound)) return;
  const delivered = await Promise.resolve()
    .then(() => send(line))
    .catch(() => false);
  if (delivered === true) writeFrontmatter(storyFile, { round_nudged: String(ROUND_NUDGE_AT) });
}

/** A Mac poll this recent, from a runner whose loop was awake, means the Mac can still speak a notice. */
export const MAC_POLL_LIVE_MS = 45_000;

/**
 * Whether a voice notice published now would be heard: a phone router is awake, or the Mac's loop was awake at a
 * poll in the last 45 s. A Mac whose loop is asleep queues the notice without speaking it, so its polls don't count.
 */
export function voiceNudgeLive(now: number, phoneListening: boolean, lastAwakeMacPoll: number): boolean {
  return phoneListening || now - lastAwakeMacPoll < MAC_POLL_LIVE_MS;
}
