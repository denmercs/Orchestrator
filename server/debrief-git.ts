import { execFile } from "node:child_process";
import { promisify } from "node:util";

// The git reads behind a Debrief (see CONTEXT.md, "Debrief renderer"). Read-only, run in the
// worktree; a ref or file git can't find is undefined, never a throw.

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

const tryGit = (cwd: string, args: string[]) => git(cwd, args).then((out) => out, () => undefined);

export type ChangedFile = { path: string; status: string }; // git status letter: A, M or D (renames are off)

export async function resolveCommit(cwd: string, ref: string) {
  return (await tryGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]))?.trim() || undefined;
}

export async function mergeBase(cwd: string, base: string, head: string) {
  return (await tryGit(cwd, ["merge-base", base, head]))?.trim() || undefined;
}

export async function changedFiles(cwd: string, from: string, head: string): Promise<ChangedFile[]> {
  const out = await git(cwd, ["diff", "--name-status", "-z", "--no-renames", `${from}..${head}`, "--"]);
  const parts = out.split("\0").filter(Boolean);
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i]!, path: parts[i + 1]! });
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// `head` itself when it names a branch, else the worktree's current branch, else "detached".
export async function headInfo(cwd: string, head: string) {
  const [sha = "", date = ""] = (await git(cwd, ["log", "-1", "--format=%H%n%cI", head, "--"])).trim().split("\n");
  const named = (await tryGit(cwd, ["rev-parse", "--verify", "--symbolic-full-name", head]))?.trim();
  const current = (await tryGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]))?.trim();
  const branch = named?.startsWith("refs/heads/") ? named.slice("refs/heads/".length) : current || "detached";
  return { sha, date, branch };
}

export async function lineCountAt(cwd: string, head: string, file: string) {
  const text = await tryGit(cwd, ["show", `${head}:${file}`]);
  if (text === undefined) return undefined;
  return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}
