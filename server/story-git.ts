import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { gh, prForBranch } from "./pr-checks";

// The mechanical git and GitHub steps of a story. These used to be agent steps; they never needed
// judgment, so the plugin runs them itself and only spends a model on writing and reviewing code.

const execFileAsync = promisify(execFile);

// .harness/ is the story's working folder and never goes into a commit.
const NOT_HARNESS = ["--", ".", ":(exclude).harness"];

async function git(cwd: string, args: string[], timeout = 60_000) {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

export async function currentBranch(cwd: string) {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

// Commits everything the agent changed outside .harness/. Returns false when there was nothing to commit.
export async function commitStory(cwd: string, message: string) {
  await git(cwd, ["add", "-A", ...NOT_HARNESS]);
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

export type OpenedPr = { number: number; url: string };

// Commits leftovers, pushes the branch and opens the PR (or keeps the one already open).
export async function openStoryPr(
  cwd: string,
  input: { id: string; title: string; branch: string; base: string },
): Promise<OpenedPr> {
  const base = input.base.replace(/^origin\//, "");
  if (!input.branch || input.branch === "HEAD" || input.branch === base) {
    throw new Error(`Refusing to open a PR from "${input.branch || "no branch"}".`);
  }
  await commitStory(cwd, `${input.id}: Remaining changes`);
  await git(cwd, ["push", "-u", "origin", input.branch], 120_000);
  const existing = await prForBranch(cwd, input.branch);
  if (existing) {
    return existing;
  }
  const bodyFile = join(cwd, ".harness", "pr-body.md");
  const body = existsSync(bodyFile) ? readFileSync(bodyFile, "utf8").trim() : "";
  await gh(
    [
      "pr",
      "create",
      "--base",
      base,
      "--head",
      input.branch,
      "--title",
      `${input.id}: ${input.title}`,
      "--body",
      body || `${input.id}: ${input.title}`,
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
