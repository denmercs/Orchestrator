import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { gh, prStatus, type PrStatus } from "./pr-checks";
import { beforeRoger, normalise } from "./voice-bridge";

// "Merge it" by voice: find the PR of the session that last finished a turn, check it, and speak a
// short review. Nothing merges until the user says "confirm", and only the head that was reviewed.

export type PrFacts = {
  number: number;
  title: string;
  body: string;
  state: string;
  isDraft: boolean;
  mergeable: string;
  reviewDecision: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  headRefOid: string;
};

export type MergePort = {
  // The session whose turn ended last, with its working directory, or null when none has.
  lastSession(): Promise<{ title: string | null; cwd: string } | null>;
  // The open PR for the current branch in `cwd`, or null when there is none.
  pr(cwd: string): Promise<PrFacts | null>;
  checks(cwd: string, number: number): Promise<PrStatus | null>;
  // A few spoken sentences on what the diff does and what looks off, or null when it can't be had.
  explain(cwd: string, facts: PrFacts): Promise<string | null>;
  merge(cwd: string, number: number, headSha: string): Promise<void>;
};

export type VoiceReply = { said: string; listen: boolean };

type Pending = { cwd: string; number: number; headSha: string; at: number };

const MERGE = new Set(["merge", "merge it", "just merge it", "merge that", "merge the pr", "merge the pull request", "go merge it"]);
const CONFIRM = new Set(["confirm", "confirmed", "confirm it", "yes confirm", "confirm merge"]);
const NO = new Set(["no", "nope", "stop", "cancel", "dont", "do not", "never mind", "nevermind"]);

// A confirm long after the review could be about a different moment; ask again instead.
const CONFIRM_WINDOW_MS = 2 * 60_000;
const MAX_SUMMARY = 160;

// The first prose line of a PR body, skipping headings like "## Purpose".
export function bodySummary(body: string): string {
  const line = body
    .split("\n")
    .map((text) => text.replace(/^[-*>\s]+/, "").trim())
    .find((text) => text && !text.startsWith("#") && !text.startsWith("<!--"));
  if (!line) return "";
  return line.length > MAX_SUMMARY ? `${line.slice(0, MAX_SUMMARY)}…` : line;
}

// What stands between this PR and a clean merge, worst first. Empty means it looks good.
export function concerns(facts: PrFacts, checks: PrStatus | null): string[] {
  const found: string[] = [];
  if (facts.mergeable === "CONFLICTING") found.push("it has merge conflicts");
  if (checks?.state === "failing") found.push(`checks are failing: ${checks.failing.map((check) => check.name).join(", ")}`);
  if (facts.reviewDecision === "CHANGES_REQUESTED") found.push("a reviewer requested changes");
  if (facts.isDraft) found.push("it is still a draft");
  if (checks?.state === "pending") found.push("checks are still running");
  if (!checks) found.push("I couldn't read its checks");
  return found;
}

// `explained` is the model's read of the diff; without it the body's first line stands in.
export function spokenReview(facts: PrFacts, checks: PrStatus | null, explained: string | null = null): string {
  const summary = explained?.trim() || bodySummary(facts.body);
  const size = `${facts.changedFiles} ${facts.changedFiles === 1 ? "file" : "files"}, ${facts.additions} lines added, ${facts.deletions} removed.`;
  const issues = concerns(facts, checks);
  const status = checks?.state === "green" ? "Checks passed." : checks?.state === "no-checks" ? "It has no checks." : "";
  const verdict = issues.length
    ? `I wouldn't merge it yet: ${issues.join("; ")}. Say confirm to merge anyway, or no.`
    : `${status} No conflicts. Looks good. Say confirm to merge, or no.`;
  return [`PR ${facts.number}: ${facts.title}.`, summary, size, verdict].filter(Boolean).join(" ").replace(/\s+/g, " ");
}

export function createVoiceMerge(port: MergePort, now: () => number = Date.now) {
  let pending: Pending | null = null;

  async function review(): Promise<VoiceReply> {
    pending = null;
    const session = await port.lastSession();
    if (!session) return { said: "No session has finished yet, so I don't know which PR you mean.", listen: false };
    const who = session.title?.trim() || "The last session";
    const facts = await port.pr(session.cwd);
    if (!facts || facts.state !== "OPEN") return { said: `${who} has no open PR.`, listen: false };
    const [checks, explained] = await Promise.all([
      port.checks(session.cwd, facts.number),
      port.explain(session.cwd, facts).catch((error: unknown) => {
        console.warn("orchestrator: voice PR summary failed", error instanceof Error ? error.message : error);
        return null;
      }),
    ]);
    pending = { cwd: session.cwd, number: facts.number, headSha: facts.headRefOid, at: now() };
    return { said: spokenReview(facts, checks, explained), listen: true };
  }

  async function merge(): Promise<VoiceReply> {
    const target = pending;
    pending = null;
    if (!target || now() - target.at > CONFIRM_WINDOW_MS) {
      return { said: "There's nothing waiting to merge. Say merge it first.", listen: false };
    }
    try {
      await port.merge(target.cwd, target.number, target.headSha);
      return { said: `Merged PR ${target.number}.`, listen: false };
    } catch (error) {
      console.warn("orchestrator: voice merge failed", error instanceof Error ? error.message : error);
      return { said: `GitHub didn't merge PR ${target.number}. Check it in the app.`, listen: false };
    }
  }

  return {
    async command(text: string): Promise<VoiceReply> {
      // A habitual "roger" at the end, as voice replies use, is not part of the command.
      const words = normalise(beforeRoger(text) ?? text);
      if (!words) return { said: "I didn't catch that.", listen: true };
      if (MERGE.has(words)) return review();
      if (CONFIRM.has(words)) return merge();
      if (NO.has(words)) {
        const had = pending;
        pending = null;
        return { said: had ? "Okay, not merging." : "Okay.", listen: false };
      }
      return { said: "I can merge the last session's PR. Say merge it.", listen: false };
    },
  };
}

export type VoiceMerge = ReturnType<typeof createVoiceMerge>;

const PR_FIELDS = "number,title,body,state,isDraft,mergeable,reviewDecision,additions,deletions,changedFiles,headRefOid";

// Prefer a merge commit, as the repo history does, falling back to what the repo allows.
async function mergeMethod(cwd: string): Promise<string> {
  try {
    const allowed = JSON.parse(
      await gh(["repo", "view", "--json", "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed"], cwd),
    ) as { mergeCommitAllowed?: boolean; squashMergeAllowed?: boolean; rebaseMergeAllowed?: boolean };
    if (allowed.mergeCommitAllowed) return "--merge";
    if (allowed.squashMergeAllowed) return "--squash";
    if (allowed.rebaseMergeAllowed) return "--rebase";
  } catch {
    // Fall through: GitHub refuses a disallowed method and the user hears that it didn't merge.
  }
  return "--merge";
}

const execFileAsync = promisify(execFile);

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

export async function claudeExplain(facts: PrFacts, diff: string, run: RunClaude = runClaude): Promise<string | null> {
  const clipped = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff cut off here]` : diff;
  // No tools and no MCP servers: it only reads what it is given, and starts faster.
  const args = ["-p", "--model", "haiku", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", EXPLAIN_PROMPT];
  const text = (await run(args, `Title: ${facts.title}\n\nDescription:\n${facts.body}\n\nDiff:\n${clipped}`))
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

// "dm/voice-merge" for an upstream of "origin/dm/voice-merge", or null when there is none.
async function upstreamBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "@{u}"], { cwd, timeout: 5_000 });
    return stdout.trim().replace(/^[^/]+\//, "") || null;
  } catch {
    return null;
  }
}

export const ghMergePort: Omit<MergePort, "lastSession"> = {
  async pr(cwd) {
    // A renamed local branch no longer matches the PR's head, so fall back to the upstream's name.
    for (const branch of [null, await upstreamBranch(cwd)]) {
      try {
        return JSON.parse(await gh(["pr", "view", ...(branch ? [branch] : []), "--json", PR_FIELDS], cwd)) as PrFacts;
      } catch {
        // Try the next name.
      }
    }
    return null;
  },
  checks: prStatus,
  async explain(cwd, facts) {
    const diff = await gh(["pr", "diff", String(facts.number)], cwd);
    return claudeExplain(facts, diff);
  },
  async merge(cwd, number, headSha) {
    // --match-head-commit: a push after the review makes GitHub refuse instead of merging unseen code.
    await gh(["pr", "merge", String(number), await mergeMethod(cwd), "--match-head-commit", headSha], cwd, 60_000);
  },
};
