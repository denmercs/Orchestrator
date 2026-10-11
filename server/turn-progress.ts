import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { briefTestFailures } from "../shared/stuck";

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
