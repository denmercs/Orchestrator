import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commitStory, openStoryPr } from "./story-git";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "story-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("commit", "-q", "--allow-empty", "-m", "init");
  return { dir, git, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("commits the agent's changes but never .harness/", async () => {
  const { dir, git, done } = repo();
  try {
    writeFileSync(join(dir, "search.ts"), "export const x = 1;\n");
    mkdirSync(join(dir, ".harness"));
    writeFileSync(join(dir, ".harness", "state.md"), "## Status\nimplement-done\n");

    assert.equal(await commitStory(dir, "S1: Cycle 1 — Parse"), true);
    assert.equal(git("log", "-1", "--format=%s"), "S1: Cycle 1 — Parse");
    assert.equal(git("show", "--name-only", "--format=", "HEAD"), "search.ts");
    assert.match(git("status", "--porcelain"), /\?\? \.harness\//);
  } finally {
    done();
  }
});

test("commits when .harness/ is in .git/info/exclude", async () => {
  const { dir, git, done } = repo();
  try {
    writeFileSync(join(dir, "search.ts"), "export const x = 1;\n");
    git("add", "search.ts");
    git("commit", "-q", "-m", "add search");
    writeFileSync(join(dir, ".git", "info", "exclude"), ".harness/\n");
    writeFileSync(join(dir, "search.ts"), "export const x = 2;\n");
    mkdirSync(join(dir, ".harness"));
    writeFileSync(join(dir, ".harness", "state.md"), "## Status\nimplement-done\n");

    assert.equal(await commitStory(dir, "S1: Cycle 1 — Parse"), true);
    assert.equal(git("show", "--name-only", "--format=", "HEAD"), "search.ts");
    assert.equal(git("status", "--porcelain"), "");
  } finally {
    done();
  }
});

test("nothing to commit is not an error", async () => {
  const { dir, git, done } = repo();
  try {
    assert.equal(await commitStory(dir, "S1: nothing"), false);
    assert.equal(git("rev-list", "--count", "HEAD"), "1");
  } finally {
    done();
  }
});

test("refuses to open a PR from the base branch or a detached HEAD", async () => {
  const { dir, done } = repo();
  try {
    await assert.rejects(openStoryPr(dir, { id: "S1", title: "x", branch: "main", base: "origin/main" }), /Refusing/);
    await assert.rejects(openStoryPr(dir, { id: "S1", title: "x", branch: "HEAD", base: "origin/main" }), /Refusing/);
  } finally {
    done();
  }
});
