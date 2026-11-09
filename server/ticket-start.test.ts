import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readStoryFiles } from "./harness-layout";
import { startLocalTicket, startTicket } from "./ticket-start";

const ticketRepo = () => {
  const repo = mkdtempSync(join(tmpdir(), "ticket-start-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  return repo;
};
const issue = (issueType: string) => ({
  issueType,
  summary: "Fix login",
  url: "https://example.atlassian.net/browse/QUICK-12",
});

test("startTicket reads the issue, creates the initiative and files it for the manager", async () => {
  const repo = ticketRepo();
  try {
    const reads: string[] = [];
    const filed: { repo: string; initiative: string }[] = [];
    const result = await startTicket(
      { repo, key: "quick-12" },
      {
        readIssue: async (key) => {
          reads.push(key);
          return issue("Bug");
        },
        file: async (input) => {
          filed.push(input);
          return ["quick-12-s1"];
        },
      },
    );
    assert.deepEqual(reads, ["QUICK-12"]);
    assert.ok(existsSync(join(repo, ".harness", "initiatives", "quick-12-fix-login", "initiative.md")));
    assert.deepEqual(filed, [{ repo, initiative: "quick-12-fix-login" }]);
    assert.deepEqual(result, {
      ok: true,
      error: null,
      initiative: "quick-12-fix-login",
      track: "diagnose",
      slices: ["quick-12-s1"],
      agentId: null,
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("startTicket returns an error and starts no loop for an unknown issue or a failed read", async () => {
  const repo = ticketRepo();
  try {
    const filed: unknown[] = [];
    const file = async (input: { repo: string; initiative: string }) => {
      filed.push(input);
      return [];
    };
    const unknown = await startTicket({ repo, key: "QUICK-404" }, { readIssue: async () => null, file });
    assert.equal(unknown.ok, false);
    assert.match(unknown.error ?? "", /QUICK-404/);
    const thrown = await startTicket(
      { repo, key: "QUICK-12" },
      {
        readIssue: async () => {
          throw new Error("Jira is down");
        },
        file,
      },
    );
    assert.equal(thrown.ok, false);
    assert.equal(thrown.error, "Jira is down");
    assert.deepEqual(filed, []);
    assert.ok(!existsSync(join(repo, ".harness", "initiatives")));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

const okFile = async (input: { repo: string; initiative: string }) => {
  void input;
  return ["a-slice"];
};

const seedInitiative = (repo: string, slug: string) => {
  const dir = join(repo, ".harness", "initiatives", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "initiative.md"), `---\ntracker: local\n---\n\n# Initiative: ${slug}\n`, "utf8");
};

test("startLocalTicket mints PROMOTE-1 in a fresh repo and files it as a Story", async () => {
  const repo = ticketRepo();
  try {
    const filed: { repo: string; initiative: string }[] = [];
    const result = await startLocalTicket(
      { repo, title: "Try the new idea", kind: "story" },
      {
        file: async (input) => {
          filed.push(input);
          return ["promote-1-s1"];
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.error, null);
    assert.equal(result.key, "PROMOTE-1");
    assert.equal(result.initiative, "promote-1-try-the-new-idea");
    assert.equal(result.track, "plan");
    assert.deepEqual(result.slices, ["promote-1-s1"]);
    assert.equal(result.agentId, null);
    assert.deepEqual(filed, [{ repo, initiative: "promote-1-try-the-new-idea" }]);
    const stories = readStoryFiles(join(repo, ".harness", "initiatives", "promote-1-try-the-new-idea", "phases", "1-try-the-new-idea"));
    assert.equal(stories.length, 1);
    assert.equal(stories[0].meta.jira, "PROMOTE-1");
    // "plan" track should NOT write a track field.
    assert.equal(stories[0].meta.track, undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("startLocalTicket picks the next PROMOTE-<n> after the highest existing one", async () => {
  const repo = ticketRepo();
  try {
    seedInitiative(repo, "promote-3-older");
    seedInitiative(repo, "promote-1-oldest");
    seedInitiative(repo, "other-99-unrelated");
    const result = await startLocalTicket(
      { repo, title: "Next up", kind: "story" },
      { file: okFile },
    );
    assert.equal(result.ok, true);
    assert.equal(result.key, "PROMOTE-4");
    assert.equal(result.initiative, "promote-4-next-up");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("startLocalTicket with kind: bug sets Bug issueType and the Diagnose track", async () => {
  const repo = ticketRepo();
  try {
    const result = await startLocalTicket(
      { repo, title: "Fix the thing", kind: "bug" },
      { file: okFile },
    );
    assert.equal(result.ok, true);
    assert.equal(result.track, "diagnose");
    const stories = readStoryFiles(join(repo, ".harness", "initiatives", "promote-1-fix-the-thing", "phases", "1-fix-the-thing"));
    assert.equal(stories[0].meta.track, "diagnose");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("startLocalTicket returns the filing failure without throwing", async () => {
  const repo = ticketRepo();
  try {
    const result = await startLocalTicket(
      { repo, title: "Will fail", kind: "story" },
      {
        file: async () => {
          throw new Error("nope");
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "nope");
    assert.equal(result.agentId, null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("startLocalTicket rejects an empty title", async () => {
  const repo = ticketRepo();
  try {
    let called = false;
    const result = await startLocalTicket(
      { repo, title: "   ", kind: "story" },
      {
        file: async () => {
          called = true;
          return [];
        },
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /title/i);
    assert.equal(called, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
