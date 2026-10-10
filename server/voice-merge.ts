import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readSection } from "../shared/story-method";
import { readOutcome } from "../shared/story-outcome";
import { PHASES_DIR, dirsIn, initiativesDir, readStoryFiles } from "./harness-layout";
import { gh, prStatus, type PrStatus } from "./pr-checks";
import { clip, type MergePort, type MergeReady } from "./voice-bridge";

// Voice merge: story PRs at the merge gate (open, CI green) are read out with their review, and
// "merge" merges one after GitHub confirms again that it is green, conflict-free and unchanged.
// The plugin runs gh as you; no agent merges.

const readText = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The first line of the PR body's Purpose, else its first line of prose.
function purposeOf(prBody: string): string {
  const lines = prBody.split("\n").map((line) => line.trim());
  const inline = lines.map((line) => /^\**purpose\**:\**\s*(.+)$/i.exec(line)?.[1]).find(Boolean);
  if (inline) return inline;
  const heading = lines.findIndex((line) => /^#+\s*purpose\b|^\*\*purpose\*\*$/i.test(line));
  const after = heading >= 0 ? lines.slice(heading + 1) : lines;
  return after.find((line) => line && !line.startsWith("#")) ?? "";
}

// Spoken text clipped and without its own full stop, since the sentence adds one.
const bare = (text: string) => clip(text).replace(/[.!?]+$/, "");

function listed(lines: string[]): string {
  return lines.length > 1 ? `${bare(lines[0])}, and ${lines.length - 1} more` : bare(lines[0]);
}

// What the review found, said before the merge question. failedRounds is the story's review_rounds.
export function reviewSummary(input: { state: string; prBody: string; failedRounds: number; fixAttempts: number }): string {
  const purpose = purposeOf(input.prBody);
  if (!input.state.trim() && !purpose) return "No review on record.";
  const findings = readSection(input.state, "Review findings")
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => line && !/^(none|n\/a)\b/i.test(line));
  const fixed = findings.filter((line) => /^fixed:/i.test(line));
  const followUps = findings.filter((line) => /^follow-up:/i.test(line)).map((line) => line.replace(/^follow-up:\s*/i, ""));
  const open = findings.filter((line) => !/^(fixed|follow-up):/i.test(line));
  const parts = [
    purpose ? `Purpose: ${bare(purpose)}.` : "",
    input.state.trim()
      ? input.failedRounds > 0
        ? `Review passed after ${input.failedRounds + 1} rounds.`
        : "Review passed on the first round."
      : "",
    fixed.length > 0 ? `${plural(fixed.length, "finding")} fixed.` : findings.length === 0 && input.state.trim() ? "No findings." : "",
    open.length > 0 ? `Still open: ${listed(open)}.` : "",
    followUps.length > 0 ? `Follow-up: ${listed(followUps)}.` : "",
    input.fixAttempts > 0 ? `CI needed ${input.fixAttempts === 1 ? "1 fix" : `${input.fixAttempts} fixes`}.` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

// Every story PR at the merge gate in the loop's repos, in repo, initiative, phase and story order.
export function readyToMerge(roots: string[]): MergeReady[] {
  return roots.flatMap((root) =>
    dirsIn(initiativesDir(root)).flatMap((slug) => {
      const phases = join(initiativesDir(root), slug, PHASES_DIR);
      return dirsIn(phases).flatMap((phase) =>
        readStoryFiles(join(phases, phase)).flatMap((story) => {
          const pr = Number(story.meta.pr);
          if (story.meta.status !== "pr-open" || story.meta.ci !== "green" || !Number.isInteger(pr) || pr <= 0) return [];
          const worktree = story.meta.worktree && existsSync(story.meta.worktree) ? story.meta.worktree : "";
          const outcome = readOutcome(readText(story.path));
          const review = reviewSummary({
            state: worktree ? readText(join(worktree, ".harness", "state.md")) : "",
            prBody: worktree ? readText(join(worktree, ".harness", "pr-body.md")) : "",
            failedRounds: outcome.reviewRounds,
            fixAttempts: outcome.fixAttempts,
          });
          return [
            { id: `merge:${root}:${slug}:${story.id}:${pr}`, storyId: story.id, title: story.meta.title || story.id, pr, cwd: worktree || root, review },
          ];
        }),
      );
    }),
  );
}

export type MergeView = { isDraft: boolean; mergeable: string; mergeStateStatus: string; headRefOid: string };

// Why GitHub's current view of the PR rules out merging it, or null when it is safe to merge.
export function mergeBlocker(status: PrStatus | null, view: MergeView): string | null {
  if (!status) return "couldn't be checked with GitHub";
  if (status.state === "merged") return "is already merged";
  if (status.state === "closed") return "was closed";
  if (status.state === "failing") return `has a failing check: ${status.failing.map((check) => check.name).join(", ")}`;
  if (status.state === "pending") return "still has checks running";
  if (status.state === "no-checks") return "has no CI checks";
  if (view.headRefOid !== status.headSha) return "changed while it was being checked";
  if (view.isDraft) return "is a draft";
  if (view.mergeable === "CONFLICTING" || view.mergeStateStatus === "DIRTY") return "has conflicts with its base branch";
  if (view.mergeable !== "MERGEABLE" || view.mergeStateStatus === "UNKNOWN") return "is still being checked by GitHub. Try again in a minute";
  if (view.mergeStateStatus === "BEHIND") return "is behind its base branch";
  if (view.mergeStateStatus === "BLOCKED") return "is blocked by a branch rule, such as a required review";
  if (view.mergeStateStatus !== "CLEAN" && view.mergeStateStatus !== "HAS_HOOKS") return `can't merge yet: ${view.mergeStateStatus.toLowerCase()}`;
  return null;
}

type MergeDeps = { status: typeof prStatus; gh: typeof gh };

// Merges with a merge commit, pinned to the head GitHub just checked, so a later push can't slip in.
export async function mergeStoryPr(item: MergeReady, deps: MergeDeps = { status: prStatus, gh }) {
  const pr = String(item.pr);
  try {
    const status = await deps.status(item.cwd, item.pr);
    const view = JSON.parse(
      await deps.gh(["pr", "view", pr, "--json", "isDraft,mergeable,mergeStateStatus,headRefOid"], item.cwd),
    ) as MergeView;
    const blocker = mergeBlocker(status, view);
    if (blocker) return { merged: false, said: `PR ${pr} ${blocker}. Not merged.` };
    await deps.gh(["pr", "merge", pr, "--merge", "--match-head-commit", view.headRefOid], item.cwd, 60_000);
    return { merged: true, said: `Merged PR ${pr}.` };
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const line = typeof stderr === "string" ? stderr.trim().split("\n")[0].replace(/\.$/, "") : "";
    return { merged: false, said: `PR ${pr} did not merge${line ? `: ${clip(line)}` : ""}.` };
  }
}

export function voiceMergePort(roots: () => string[]): MergePort {
  return { ready: () => readyToMerge(roots()), merge: (item) => mergeStoryPr(item) };
}
