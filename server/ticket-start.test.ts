import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startTicket } from "./ticket-start";

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

test("startTicket reads the issue, creates the initiative and starts its loop", async () => {
  const repo = ticketRepo();
  try {
    const reads: string[] = [];
    const loops: { repo: string; initiative: string }[] = [];
    const result = await startTicket(
      { repo, key: "quick-12" },
      {
        readIssue: async (key) => {
          reads.push(key);
          return issue("Bug");
        },
        startLoop: async (input) => {
          loops.push(input);
          return { ok: true, error: null, started: [{ story: "S1", agentId: "agent-1" }] };
        },
      },
    );
    assert.deepEqual(reads, ["QUICK-12"]);
    assert.ok(existsSync(join(repo, ".harness", "initiatives", "quick-12-fix-login", "initiative.md")));
    assert.deepEqual(loops, [{ repo, initiative: "quick-12-fix-login" }]);
    assert.deepEqual(result, {
      ok: true,
      error: null,
      initiative: "quick-12-fix-login",
      track: "diagnose",
      agentId: "agent-1",
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("startTicket returns an error and starts no loop for an unknown issue or a failed read", async () => {
  const repo = ticketRepo();
  try {
    const loops: unknown[] = [];
    const startLoop = async (input: { repo: string; initiative: string }) => {
      loops.push(input);
      return { ok: true, error: null, started: [] };
    };
    const unknown = await startTicket({ repo, key: "QUICK-404" }, { readIssue: async () => null, startLoop });
    assert.equal(unknown.ok, false);
    assert.match(unknown.error ?? "", /QUICK-404/);
    const thrown = await startTicket(
      { repo, key: "QUICK-12" },
      {
        readIssue: async () => {
          throw new Error("Jira is down");
        },
        startLoop,
      },
    );
    assert.equal(thrown.ok, false);
    assert.equal(thrown.error, "Jira is down");
    assert.deepEqual(loops, []);
    assert.ok(!existsSync(join(repo, ".harness", "initiatives")));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
