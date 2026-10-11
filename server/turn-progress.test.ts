import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { briefRuns, worktreeFingerprint } from "./turn-progress";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "turn-progress-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

test("worktreeFingerprint ignores .harness/ edits", () => {
  const dir = repo();
  try {
    const before = worktreeFingerprint(dir);
    assert.ok(before);
    mkdirSync(join(dir, ".harness"));
    writeFileSync(join(dir, ".harness", "state.md"), "x");
    assert.equal(worktreeFingerprint(dir), before);
    writeFileSync(join(dir, ".harness", "state.md"), "xy");
    assert.equal(worktreeFingerprint(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktreeFingerprint changes on a tracked edit, an untracked file, and a commit", () => {
  const dir = repo();
  try {
    const seen = new Set<string | null>([worktreeFingerprint(dir)]);
    writeFileSync(join(dir, "a.txt"), "two\n");
    seen.add(worktreeFingerprint(dir));
    assert.equal(seen.size, 2);
    writeFileSync(join(dir, "b.txt"), "new");
    seen.add(worktreeFingerprint(dir));
    assert.equal(seen.size, 3);
    writeFileSync(join(dir, "b.txt"), "newer");
    seen.add(worktreeFingerprint(dir));
    assert.equal(seen.size, 4);
    git(dir, "add", "a.txt", "b.txt");
    git(dir, "commit", "-q", "-m", "two");
    seen.add(worktreeFingerprint(dir));
    assert.equal(seen.size, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktreeFingerprint is null outside a git repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "turn-progress-"));
  try {
    assert.equal(worktreeFingerprint(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("briefRuns lists test-run logs for the step since the window, oldest first", () => {
  const dir = mkdtempSync(join(tmpdir(), "turn-progress-"));
  try {
    const logs = join(dir, ".harness", "logs");
    mkdirSync(logs, { recursive: true });
    const put = (name: string, body: string, sec: number) => {
      writeFileSync(join(logs, name), body);
      utimesSync(join(logs, name), sec, sec);
    };
    const fail = "not ok 1 - breaks\n# tests 2\n# fail 1\n";
    put("implement-2026-01-01T00-00-03.log", "# tests 1\n# pass 1\n", 3000);
    put("implement-2026-01-01T00-00-02.log", fail, 2000);
    put("implement-2026-01-01T00-00-01.log", fail, 1000);
    put("implement-2026-01-01T00-00-04.log", "tsc ok\n", 4000);
    put("review-2026-01-01T00-00-06.log", fail, 6000);
    const runs = briefRuns(dir, "implement", 2000 * 1000);
    assert.deepEqual(
      runs.map((r) => [r.name, r.mtimeMs, r.failures]),
      [
        ["implement-2026-01-01T00-00-02.log", 2000 * 1000, ["breaks"]],
        ["implement-2026-01-01T00-00-03.log", 3000 * 1000, []],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("briefRuns is empty when the logs dir is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "turn-progress-"));
  try {
    assert.deepEqual(briefRuns(dir, "implement", 0), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
