import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// A stub gh: `pr view` fails until `pr create` has run (or `open` exists), and each create's args are logged.
const ghDir = mkdtempSync(join(tmpdir(), "story-git-gh-"));
const ghOpen = join(ghDir, "open");
const ghCreates = join(ghDir, "creates.jsonl");
process.env.GH_BIN = join(ghDir, "gh");
writeFileSync(
  process.env.GH_BIN,
  `#!/usr/bin/env node
const fs = require("node:fs");
const [cmd, sub] = process.argv.slice(2);
if (cmd === "pr" && sub === "view") {
  if (!fs.existsSync(${JSON.stringify(ghOpen)})) process.exit(1);
  process.stdout.write(JSON.stringify({ number: 7, url: "https://pr/7", state: "OPEN" }));
} else if (cmd === "pr" && sub === "create") {
  fs.appendFileSync(${JSON.stringify(ghCreates)}, JSON.stringify(process.argv.slice(2)) + "\\n");
  fs.writeFileSync(${JSON.stringify(ghOpen)}, "");
} else process.exit(1);
`,
  "utf8",
);
chmodSync(process.env.GH_BIN, 0o755);
const { commitStory, openStoryPr, uniqueBranch } = await import("./story-git");

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
    await assert.rejects(openStoryPr(dir, { id: "S1", title: "x", jira: false, branch: "main", base: "origin/main" }), /Refusing/);
    await assert.rejects(openStoryPr(dir, { id: "S1", title: "x", jira: false, branch: "HEAD", base: "origin/main" }), /Refusing/);
  } finally {
    done();
  }
});

// A repo on a feature branch with an `origin` it can push to, and the stub gh reset.
function prRepo() {
  const r = repo();
  const remote = mkdtempSync(join(tmpdir(), "story-git-remote-"));
  execFileSync("git", ["init", "-q", "--bare", remote]);
  r.git("remote", "add", "origin", remote);
  r.git("checkout", "-q", "-b", "feature/s1");
  rmSync(ghOpen, { force: true });
  rmSync(ghCreates, { force: true });
  const created = () =>
    existsSync(ghCreates) ? readFileSync(ghCreates, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : [];
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
  return { ...r, created, flag, done: () => (r.done(), rmSync(remote, { recursive: true, force: true })) };
}

const prCases = [
  { name: "initiative story", input: { id: "S1", title: "Add search", jira: false }, title: "Add search", headline: "Story: S1 — Add search" },
  { name: "Jira ticket", input: { id: "DCD-1", title: "Add search", jira: true }, title: "DCD-1 | Add search", headline: "Jira: DCD-1 — Add search" },
];

for (const c of prCases) {
  test(`PR for a ${c.name}: title, and the headline above .harness/pr-body.md`, async () => {
    const { dir, created, flag, done } = prRepo();
    try {
      mkdirSync(join(dir, ".harness"));
      writeFileSync(join(dir, ".harness", "pr-body.md"), "## Purpose\nFind things.\n");
      const pr = await openStoryPr(dir, { ...c.input, branch: "feature/s1", base: "origin/main" });
      assert.deepEqual(pr, { number: 7, url: "https://pr/7" });
      const [args] = created();
      assert.equal(flag(args, "--title"), c.title);
      assert.equal(flag(args, "--body"), `${c.headline}\n\n## Purpose\nFind things.`);
    } finally {
      done();
    }
  });

  test(`PR for a ${c.name} without .harness/pr-body.md: the body is just the headline`, async () => {
    const { dir, created, flag, done } = prRepo();
    try {
      await openStoryPr(dir, { ...c.input, branch: "feature/s1", base: "origin/main" });
      const [args] = created();
      assert.equal(flag(args, "--title"), c.title);
      assert.equal(flag(args, "--body"), c.headline);
    } finally {
      done();
    }
  });
}

test("leftovers are committed as \"Commit remaining changes\" before the PR opens", async () => {
  const { dir, git, done } = prRepo();
  try {
    writeFileSync(join(dir, "search.ts"), "export const x = 1;\n");
    await openStoryPr(dir, { id: "S1", title: "Add search", jira: false, branch: "feature/s1", base: "origin/main" });
    assert.equal(git("log", "-1", "--format=%s"), "Commit remaining changes");
  } finally {
    done();
  }
});

test("an already-open PR is returned as it is, without creating another", async () => {
  const { dir, created, done } = prRepo();
  try {
    writeFileSync(ghOpen, "");
    const pr = await openStoryPr(dir, { id: "S1", title: "Add search", jira: false, branch: "feature/s1", base: "origin/main" });
    assert.deepEqual(pr, { number: 7, url: "https://pr/7" });
    assert.deepEqual(created(), []);
  } finally {
    done();
  }
});

test("a branch with no commits over its base opens no PR and pushes nothing", async () => {
  const { dir, git, created, done } = prRepo();
  try {
    git("push", "-q", "origin", "HEAD:refs/heads/main");
    git("fetch", "-q", "origin");
    assert.equal(await openStoryPr(dir, { id: "S1", title: "Add search", jira: false, branch: "feature/s1", base: "origin/main" }), null);
    assert.deepEqual(created(), []);
    assert.equal(git("ls-remote", "--heads", "origin", "feature/s1"), "");
  } finally {
    done();
  }
});

test("uniqueBranch adds -2, -3 when the name exists locally or on origin", async () => {
  const { dir, git, done } = repo();
  const remote = mkdtempSync(join(tmpdir(), "story-git-remote-"));
  try {
    assert.equal(await uniqueBranch(dir, "dm/add-search"), "dm/add-search");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git("remote", "add", "origin", remote);
    git("branch", "dm/add-search");
    git("push", "-q", "origin", "HEAD:refs/heads/dm/add-search-2");
    git("fetch", "-q", "origin");
    assert.equal(await uniqueBranch(dir, "dm/add-search"), "dm/add-search-3");
    assert.equal(await uniqueBranch(dir, "dm/other"), "dm/other");
  } finally {
    done();
    rmSync(remote, { recursive: true, force: true });
  }
});
