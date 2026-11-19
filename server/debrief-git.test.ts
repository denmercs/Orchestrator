import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { changedFiles, headInfo, lineCountAt, mergeBase, resolveCommit } from "./debrief-git";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

// main has keep.ts and gone.ts; the branch adds new.ts, changes keep.ts and deletes gone.ts.
const repo = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "debrief-git-")));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "keep.ts"), "one\n");
  writeFileSync(join(dir, "gone.ts"), "bye\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "new.ts"), "a\nb\nc\n");
  writeFileSync(join(dir, "keep.ts"), "one\ntwo\n");
  unlinkSync(join(dir, "gone.ts"));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "work");
  return { dir, base, head: git(dir, "rev-parse", "HEAD") };
};

test("resolveCommit gives the full sha, or undefined for a ref that is not a commit", async () => {
  const { dir, head } = repo();
  assert.equal(await resolveCommit(dir, "feature"), head);
  assert.equal(await resolveCommit(dir, "no-such-ref"), undefined);
});

test("mergeBase is where the branch left main", async () => {
  const { dir, base, head } = repo();
  assert.equal(await mergeBase(dir, "main", head), base);
  assert.equal(await mergeBase(dir, "no-such-ref", head), undefined);
});

test("changedFiles lists added, modified and deleted files sorted by path", async () => {
  const { dir, base, head } = repo();
  assert.deepEqual(await changedFiles(dir, base, head), [
    { path: "gone.ts", status: "D" },
    { path: "keep.ts", status: "M" },
    { path: "new.ts", status: "A" },
  ]);
});

test("headInfo gives the sha, committer date and branch", async () => {
  const { dir, head } = repo();
  const info = await headInfo(dir, head);
  assert.equal(info.sha, head);
  assert.equal(info.date, git(dir, "log", "-1", "--format=%cI", head));
  assert.equal(info.branch, "feature");
});

test("lineCountAt counts lines at the commit, undefined when the file is not there", async () => {
  const { dir, head } = repo();
  assert.equal(await lineCountAt(dir, head, "new.ts"), 3);
  assert.equal(await lineCountAt(dir, head, "gone.ts"), undefined);
});

test("headInfo names the worktree's current branch for a sha, and detached when none is checked out", async () => {
  const { dir, head } = repo();
  assert.equal((await headInfo(dir, head)).branch, "feature");
  git(dir, "checkout", "-q", "--detach");
  assert.equal((await headInfo(dir, head)).branch, "detached");
});

test("a head that is also a file name in the worktree still resolves", async () => {
  const { dir, base, head } = repo();
  writeFileSync(join(dir, "feature"), "clash\n"); // ref "feature" and a file "feature"
  const info = await headInfo(dir, "feature");
  assert.equal(info.sha, head);
  assert.equal(info.branch, "feature");
  assert.equal((await changedFiles(dir, base, "feature")).length, 3);
});
