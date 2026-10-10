import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { prHeadline, prTitle } from "../shared/naming";
import { gh, prForBranch } from "./pr-checks";

// The mechanical git and GitHub steps of a story. These used to be agent steps; they never needed
// judgment, so the plugin runs them itself and only spends a model on writing and reviewing code.

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[], timeout = 60_000) {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

export async function currentBranch(cwd: string) {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

// `name`, or `name-2`, `name-3`… when that branch already exists here or on origin.
export async function uniqueBranch(cwd: string, name: string) {
  const exists = async (ref: string) =>
    git(cwd, ["show-ref", "--verify", "--quiet", ref]).then(
      () => true,
      () => false,
    );
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name}-${n}`;
    if (!(await exists(`refs/heads/${candidate}`)) && !(await exists(`refs/remotes/origin/${candidate}`))) return candidate;
  }
}

// Commits everything the agent changed outside .harness/, the story's working folder. Returns false
// when there was nothing to commit. Stages all, then unstages .harness: an exclude pathspec makes git
// exit 1 when .harness is itself ignored (.git/info/exclude), even though it staged the rest.
export async function commitStory(cwd: string, message: string) {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["reset", "-q", "--", ".harness"]);
  const staged = await git(cwd, ["diff", "--cached", "--name-only"]);
  if (!staged) {
    return false;
  }
  await git(cwd, ["commit", "-m", message]);
  return true;
}

// Commits a Fix CI agent's work and pushes it to the open PR's branch. Never force-pushes.
export async function pushStoryFix(cwd: string, message: string) {
  const committed = await commitStory(cwd, message);
  if (committed) {
    await git(cwd, ["push"], 120_000);
  }
  return committed;
}

// What a failed git or gh call said, without the command line: execFile's message repeats every
// argument, PR body included. Falls back to the message when the command printed nothing.
export function failureText(error: unknown) {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  return error instanceof Error ? error.message : String(error);
}

export type OpenedPr = { number: number; url: string };

// How many commits HEAD has that `base` doesn't; null when `base` doesn't resolve here.
async function commitsAhead(cwd: string, base: string) {
  return git(cwd, ["rev-list", "--count", `${base}..HEAD`]).then(Number, () => null);
}

// Commits leftovers (under `subject` when given), pushes the branch and opens the PR (or keeps the one
// already open). Returns null, without pushing, when the branch has no commits over its base: the work was
// already there, and gh refuses a PR with no commits.
export async function openStoryPr(
  cwd: string,
  input: { id: string; title: string; jira: boolean; branch: string; base: string; subject?: string },
): Promise<OpenedPr | null> {
  const base = input.base.replace(/^origin\//, "");
  if (!input.branch || input.branch === "HEAD" || input.branch === base) {
    throw new Error(`Refusing to open a PR from "${input.branch || "no branch"}".`);
  }
  await commitStory(cwd, input.subject ?? "Commit remaining changes");
  if ((await commitsAhead(cwd, input.base)) === 0) {
    return null;
  }
  await git(cwd, ["push", "-u", "origin", input.branch], 120_000);
  const existing = await prForBranch(cwd, input.branch);
  if (existing) {
    return existing;
  }
  const bodyFile = join(cwd, ".harness", "pr-body.md");
  const body = existsSync(bodyFile) ? readFileSync(bodyFile, "utf8").trim() : "";
  const headline = prHeadline(input);
  await gh(
    [
      "pr",
      "create",
      "--base",
      base,
      "--head",
      input.branch,
      "--title",
      prTitle(input),
      "--body",
      body ? `${headline}\n\n${body}` : headline,
    ],
    cwd,
    60_000,
  );
  const opened = await prForBranch(cwd, input.branch);
  if (!opened) {
    throw new Error(`gh created the PR but it is not visible for ${input.branch}.`);
  }
  return opened;
}
