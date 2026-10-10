import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { readSection } from "../shared/story-method";
import { readOutcome } from "../shared/story-outcome";
import { PHASES_DIR, dirsIn, initiativesDir, readStoryFiles } from "./harness-layout";
import { gh, prStatus, type PrStatus } from "./pr-checks";

// Voice merge: story PRs at the merge gate (open, CI green) are read out with a review, and "merge"
// merges one after GitHub confirms again that it is green, conflict-free, clean and unchanged.
// The review is Haiku's read of the diff, then the loop's own review. The plugin runs gh as you;
// no agent merges, and nobody has to say which PR.

export type MergeReady = { id: string; storyId: string; title: string; pr: number; cwd: string; review: string };

export type MergePort = {
  // Every story PR at the merge gate, in order.
  ready(): MergeReady[];
  // A few spoken sentences on what the diff does and what looks off, or null when it can't be had.
  explain(item: MergeReady): Promise<string | null>;
  // Checks the PR with GitHub again and merges it; `said` is the result or why it did not merge.
  merge(item: MergeReady): Promise<{ merged: boolean; said: string }>;
};

const MERGE = new Set(["merge", "merge it", "merge now", "yes merge", "just merge it"]);
const SKIP = new Set(["skip", "skip it", "no", "nope", "not now", "later", "wait"]);

const MAX_SPOKEN = 160;
// A skipped merge isn't offered again for an hour.
export const SKIP_MS = 60 * 60 * 1000;

const readText = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const normalise = (reply: string) =>
  reply
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

// Spoken text clipped and without its own full stop, since the sentence adds one.
function bare(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return (flat.length > MAX_SPOKEN ? `${flat.slice(0, MAX_SPOKEN)}…` : flat).replace(/[.!?]+$/, "");
}

// The first line of the PR body's Purpose, else its first line of prose.
function purposeOf(prBody: string): string {
  const lines = prBody.split("\n").map((line) => line.trim());
  const inline = lines.map((line) => /^\**purpose\**:\**\s*(.+)$/i.exec(line)?.[1]).find(Boolean);
  if (inline) return inline;
  const heading = lines.findIndex((line) => /^#+\s*purpose\b|^\*\*purpose\*\*$/i.test(line));
  const after = heading >= 0 ? lines.slice(heading + 1) : lines;
  return after.find((line) => line && !line.startsWith("#")) ?? "";
}

function listed(lines: string[]): string {
  return lines.length > 1 ? `${bare(lines[0])}, and ${lines.length - 1} more` : bare(lines[0]);
}

// What the loop's review found. failedRounds is the story's review_rounds.
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

export function mergeAskText(item: MergeReady, explained: string | null): string {
  const diff = explained?.trim() ? `${explained.trim()} ` : "";
  return `${item.title}, PR ${item.pr}. CI is green. ${diff}${item.review} Say merge to merge it, or skip.`;
}

// Only "merge" merges a PR; yes and confirm don't, so a misheard approval can't merge anything.
export function interpretMergeReply(reply: string): "merge" | "skip" | { said: string } {
  const words = normalise(reply);
  if (!words) return { said: "I didn't catch that." };
  if (MERGE.has(words)) return "merge";
  if (SKIP.has(words)) return "skip";
  return { said: "Say merge to merge it, or skip." };
}

// The PRs the phone offers. A PR is offered once Haiku's summary has settled (ready or failed), so a
// poll never waits on the model; the next poll picks it up. A push takes CI back to pending, which
// drops the PR and its summary, so a summary describes the head that went green.
export function createMergeQueue(port: MergePort, now: () => number = Date.now) {
  const summaries = new Map<string, string | null>();
  const explaining = new Set<string>();
  const skippedUntil = new Map<string, number>();
  // Merged or merging here; the loop marks the story merged on its next tick.
  const done = new Set<string>();

  function refresh(): MergeReady[] {
    const ready = port.ready();
    const ids = new Set(ready.map((item) => item.id));
    for (const id of [...summaries.keys()]) if (!ids.has(id)) summaries.delete(id);
    for (const item of ready) {
      if (summaries.has(item.id) || explaining.has(item.id)) continue;
      explaining.add(item.id);
      void port
        .explain(item)
        .catch((error: unknown) => {
          console.warn("orchestrator: voice PR summary failed", error instanceof Error ? error.message : error);
          return null;
        })
        .then((summary) => {
          explaining.delete(item.id);
          summaries.set(item.id, summary);
        });
    }
    return ready;
  }

  const offered = (item: MergeReady) =>
    summaries.has(item.id) && !done.has(item.id) && (skippedUntil.get(item.id) ?? 0) <= now();

  return {
    next(): { id: string; text: string } | null {
      const item = refresh().find(offered);
      return item ? { id: item.id, text: mergeAskText(item, summaries.get(item.id) ?? null) } : null;
    },
    // null when `id` is not a PR waiting to merge.
    async answer(id: string, reply: string): Promise<{ said: string } | null> {
      const item = port.ready().find((ready) => ready.id === id);
      if (!item) return null;
      const decision = interpretMergeReply(reply);
      if (typeof decision === "object") return decision;
      if (decision === "skip") {
        skippedUntil.set(item.id, now() + SKIP_MS);
        return { said: "Skipped." };
      }
      if (done.has(item.id)) return { said: `PR ${item.pr} is already merging.` };
      done.add(item.id);
      const result = await port.merge(item).catch(() => ({ merged: false, said: `PR ${item.pr} did not merge.` }));
      if (!result.merged) done.delete(item.id);
      return { said: result.said };
    },
  };
}

export type MergeQueue = ReturnType<typeof createMergeQueue>;

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

// Prefer a merge commit, as the repo history does, falling back to what the repo allows.
async function mergeMethod(cwd: string, run: typeof gh): Promise<string> {
  try {
    const allowed = JSON.parse(
      await run(["repo", "view", "--json", "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed"], cwd),
    ) as { mergeCommitAllowed?: boolean; squashMergeAllowed?: boolean; rebaseMergeAllowed?: boolean };
    if (allowed.mergeCommitAllowed) return "--merge";
    if (allowed.squashMergeAllowed) return "--squash";
    if (allowed.rebaseMergeAllowed) return "--rebase";
  } catch {
    // Fall through: GitHub refuses a disallowed method and the user hears why.
  }
  return "--merge";
}

// Merges pinned to the head GitHub just checked, so a later push can't slip in.
export async function mergeStoryPr(item: MergeReady, deps: MergeDeps = { status: prStatus, gh }) {
  const pr = String(item.pr);
  try {
    const status = await deps.status(item.cwd, item.pr);
    const view = JSON.parse(
      await deps.gh(["pr", "view", pr, "--json", "isDraft,mergeable,mergeStateStatus,headRefOid"], item.cwd),
    ) as MergeView;
    const blocker = mergeBlocker(status, view);
    if (blocker) return { merged: false, said: `PR ${pr} ${blocker}. Not merged.` };
    const method = await mergeMethod(item.cwd, deps.gh);
    await deps.gh(["pr", "merge", pr, method, "--match-head-commit", view.headRefOid], item.cwd, 60_000);
    return { merged: true, said: `Merged PR ${pr}.` };
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const line = typeof stderr === "string" ? stderr.trim().split("\n")[0] : "";
    return { merged: false, said: `PR ${pr} did not merge${line ? `: ${bare(line)}` : ""}.` };
  }
}

// Enough diff for a summary; past this the model sees the head of it and is told so.
const MAX_DIFF_CHARS = 60_000;

const EXPLAIN_PROMPT = [
  "You summarise a pull request for someone deciding by ear, on a phone, whether to merge it.",
  "Write at most three short spoken sentences, plain text, no markdown, no lists, no code, no file paths unless essential.",
  "First say what the change actually does. Then name anything that looks off: missing tests, risky edits, secrets, unrelated changes, unfinished work.",
  "If nothing looks off, end with: Nothing looks off.",
].join(" ");

// Runs the Claude Code CLI with `input` on stdin and returns its stdout.
export type RunClaude = (args: string[], input: string) => Promise<string>;

const isExecutable = (path: string) =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  );

// CLAUDE_BIN, then PATH and the usual install spots: the daemon's PATH may not include an nvm or local install.
async function findClaude(): Promise<string | null> {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const dirs = [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
    ...(process.env.NVM_BIN ? [process.env.NVM_BIN] : []),
    join(homedir(), ".local", "bin"),
    join(homedir(), ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of dirs) {
    const candidate = join(dir, "claude");
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

// Uses the signed-in Claude Code, so no API key. A temp dir keeps any project's CLAUDE.md out of it.
const runClaude: RunClaude = async (args, input) => {
  const binary = await findClaude();
  if (!binary) throw new Error("claude CLI not found (set CLAUDE_BIN)");
  return new Promise((resolve, reject) => {
    const child = execFile(binary, args, { cwd: tmpdir(), timeout: 40_000, maxBuffer: 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
    child.stdin?.end(input);
  });
};

export async function claudeExplain(
  pr: { title: string; body: string },
  diff: string,
  run: RunClaude = runClaude,
): Promise<string | null> {
  const clipped = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff cut off here]` : diff;
  // No tools and no MCP servers: it only reads what it is given, and starts faster.
  const args = ["-p", "--model", "haiku", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", EXPLAIN_PROMPT];
  const text = (await run(args, `Title: ${pr.title}\n\nDescription:\n${pr.body}\n\nDiff:\n${clipped}`))
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

async function explainPr(item: MergeReady): Promise<string | null> {
  const pr = String(item.pr);
  const [view, diff] = await Promise.all([
    gh(["pr", "view", pr, "--json", "title,body"], item.cwd),
    gh(["pr", "diff", pr], item.cwd),
  ]);
  return claudeExplain(JSON.parse(view) as { title: string; body: string }, diff);
}

export function voiceMergePort(roots: () => string[]): MergePort {
  return { ready: () => readyToMerge(roots()), explain: explainPr, merge: (item) => mergeStoryPr(item) };
}
