import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { RUN_CAP_MS, briefTestFailures } from "../shared/stuck";

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

const NOT_HARNESS = ":(exclude).harness";

// A hash of the worktree's content outside `.harness/`: HEAD, status, the diff against HEAD, and
// the size and mtime of each untracked file. It changes when the agent edits, adds or commits.
// Null when git fails.
export function worktreeFingerprint(worktree: string): string | null {
  try {
    const head = git(worktree, ["rev-parse", "HEAD"]).trim();
    const status = git(worktree, ["status", "--porcelain", "-uall", "--", ".", NOT_HARNESS]);
    const diff = git(worktree, ["diff", "HEAD", "--", ".", NOT_HARNESS]);
    const untracked = git(worktree, ["ls-files", "--others", "--exclude-standard", "-z", "--", ".", NOT_HARNESS])
      .split("\0")
      .filter(Boolean)
      .map((file) => {
        try {
          const stat = statSync(join(worktree, file));
          return `${file}:${stat.size}:${stat.mtimeMs}`;
        } catch {
          return `${file}:gone`;
        }
      });
    return createHash("sha1").update([head, status, diff, ...untracked].join("\n--\n")).digest("hex");
  } catch {
    return null;
  }
}

// The brief wrapper's test-run logs for a step (`.harness/logs/<step>-<iso>.log`) written at or
// after `sinceMs`, oldest first, with the test names each run failed. Logs without a test summary
// (typecheck, lint) are skipped. Empty when the logs directory is missing.
export function briefRuns(worktree: string, step: string, sinceMs: number): { name: string; mtimeMs: number; failures: string[] }[] {
  const dir = join(worktree, ".harness", "logs");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const runs: { name: string; mtimeMs: number; failures: string[] }[] = [];
  for (const name of names) {
    if (!name.startsWith(`${step}-`) || !name.endsWith(".log")) continue;
    try {
      const mtimeMs = statSync(join(dir, name)).mtimeMs;
      if (mtimeMs < sinceMs) continue;
      const failures = briefTestFailures(readFileSync(join(dir, name), "utf8"));
      if (failures) runs.push({ name, mtimeMs, failures });
    } catch {
      continue;
    }
  }
  return runs.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
}

// Past this a brief run no longer counts as running, so a hung test reads as idle again.
export const BRIEF_RUN_CAP_MS = RUN_CAP_MS;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

// The step's brief runs still going: `.harness/logs/<step>-<pid>.running` markers whose process is
// alive and that started under BRIEF_RUN_CAP_MS before `now`. Dead, over-cap and unreadable markers
// are skipped.
export function activeBriefRuns(worktree: string, step: string, now: number): { pid: number; startedMs: number }[] {
  const dir = join(worktree, ".harness", "logs");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const active: { pid: number; startedMs: number }[] = [];
  for (const name of names) {
    if (!name.startsWith(`${step}-`) || !name.endsWith(".running")) continue;
    try {
      const { pid, startedAt } = JSON.parse(readFileSync(join(dir, name), "utf8")) as { pid?: unknown; startedAt?: unknown };
      const startedMs = Date.parse(String(startedAt));
      if (!Number.isInteger(pid) || (pid as number) <= 0 || Number.isNaN(startedMs)) continue;
      if (now - startedMs >= BRIEF_RUN_CAP_MS || !alive(pid as number)) continue;
      active.push({ pid: pid as number, startedMs });
    } catch {
      continue;
    }
  }
  return active;
}
