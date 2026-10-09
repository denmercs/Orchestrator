import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTicketInitiative, frontmatter, readStories } from "./harness-layout";

test("readStories returns skill_warnings as skillWarnings, empty when unset", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-layout-"));
  try {
    const stories = join(dir, "stories");
    mkdirSync(stories);
    writeFileSync(join(stories, "01-a.md"), "---\nid: S1\ntitle: A\nstatus: todo\nskill_warnings: tdd not found · copy failed\n---\n");
    writeFileSync(join(stories, "02-b.md"), "---\nid: S2\ntitle: B\nstatus: todo\n---\n");
    assert.deepEqual(
      readStories(dir).map((story) => story.skillWarnings),
      ["tdd not found · copy failed", ""],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readStories returns blocked_from as blockedFrom, empty when unset", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-layout-"));
  try {
    const stories = join(dir, "stories");
    mkdirSync(stories);
    writeFileSync(join(stories, "01-a.md"), "---\nid: S1\ntitle: A\nstatus: blocked\nblocked_from: implementing\n---\n");
    writeFileSync(join(stories, "02-b.md"), "---\nid: S2\ntitle: B\nstatus: todo\n---\n");
    assert.deepEqual(
      readStories(dir).map((story) => story.blockedFrom),
      ["implementing", ""],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readStories returns track diagnose for track: diagnose frontmatter, plan otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-layout-"));
  try {
    const stories = join(dir, "stories");
    mkdirSync(stories);
    writeFileSync(join(stories, "01-a.md"), "---\nid: S1\ntitle: A\nstatus: todo\ntrack: diagnose\n---\n");
    writeFileSync(join(stories, "02-b.md"), "---\nid: S2\ntitle: B\nstatus: todo\n---\n");
    writeFileSync(join(stories, "03-c.md"), "---\nid: S3\ntitle: C\nstatus: todo\ntrack: other\n---\n");
    assert.deepEqual(
      readStories(dir).map((story) => story.track),
      ["diagnose", "plan", "plan"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ticketRepo = () => {
  const repo = mkdtempSync(join(tmpdir(), "harness-ticket-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  return repo;
};
const ticket = (repo: string, issueType: string) =>
  createTicketInitiative({
    repo,
    key: "QUICK-12",
    summary: "Fix login",
    url: "https://example.atlassian.net/browse/QUICK-12",
    issueType,
  });
const ticketDir = (repo: string) => join(repo, ".harness", "initiatives", "quick-12-fix-login");
const ticketStory = (repo: string) =>
  join(ticketDir(repo), "phases", "1-fix-login", "stories", "01-fix-login.md");

test("createTicketInitiative writes a one-story initiative on the plan track for a Story", async () => {
  const repo = ticketRepo();
  try {
    const result = await ticket(repo, "Story");
    assert.deepEqual(result, { ok: true, error: null, initiative: "quick-12-fix-login", track: "plan" });
    const initiative = readFileSync(join(ticketDir(repo), "initiative.md"), "utf8");
    assert.equal(frontmatter(initiative).tracker, "local");
    assert.match(initiative, /QUICK-12 — Fix login/);
    assert.ok(existsSync(join(ticketDir(repo), "phases", "1-fix-login", "phase.md")));
    const story = readFileSync(ticketStory(repo), "utf8");
    assert.deepEqual(frontmatter(story), {
      id: "S1",
      title: "Fix login",
      status: "todo",
      jira: "QUICK-12",
      jira_url: "https://example.atlassian.net/browse/QUICK-12",
    });
    assert.match(story, /Fix login/);
    assert.match(story, /https:\/\/example\.atlassian\.net\/browse\/QUICK-12/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("createTicketInitiative writes track: diagnose for a Bug, any case", async () => {
  const repo = ticketRepo();
  try {
    const result = await ticket(repo, "bug");
    assert.equal(result.track, "diagnose");
    assert.equal(frontmatter(readFileSync(ticketStory(repo), "utf8")).track, "diagnose");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("createTicketInitiative reuses an existing initiative for the same key and writes nothing new", async () => {
  const repo = ticketRepo();
  try {
    await ticket(repo, "Story");
    const before = readFileSync(ticketStory(repo), "utf8");
    const again = await createTicketInitiative({
      repo,
      key: "quick-12",
      summary: "Fix login again",
      url: "https://example.atlassian.net/browse/QUICK-12",
      issueType: "Story",
    });
    assert.deepEqual(again, { ok: true, error: null, initiative: "quick-12-fix-login", track: "plan" });
    assert.deepEqual(readdirSync(join(repo, ".harness", "initiatives")), ["quick-12-fix-login"]);
    assert.deepEqual(readdirSync(join(ticketDir(repo), "phases")), ["1-fix-login"]);
    assert.deepEqual(readdirSync(join(ticketDir(repo), "phases", "1-fix-login", "stories")), ["01-fix-login.md"]);
    assert.equal(readFileSync(ticketStory(repo), "utf8"), before);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
