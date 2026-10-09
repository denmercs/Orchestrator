import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { FALLBACK_AGENT_CONFIG } from "../shared/agent-runner";
import { DEFAULT_PHASES, PIPELINE_LABEL, type PipelineConfig } from "../shared/pipeline";

// gh answers every call with whatever ghPr() last set, so `pr view` reads it and `run view` gets no log.
const home = mkdtempSync(join(tmpdir(), "pipeline-home-"));
const ghReply = join(home, "gh-reply.json");
process.env.GH_BIN = join(home, "gh");
writeFileSync(process.env.GH_BIN, `#!/bin/sh\n[ -f "${ghReply}" ] && cat "${ghReply}" || exit 1\n`, "utf8");
chmodSync(process.env.GH_BIN, 0o755);
const failedCheck = {
  __typename: "CheckRun",
  name: "test",
  workflowName: "CI",
  status: "COMPLETED",
  conclusion: "FAILURE",
  detailsUrl: "https://gh/actions/runs/9/job/1",
  completedAt: "2026-10-08T12:00:00Z",
};
const ghPr = (state: string, headRefOid = "abc", statusCheckRollup: unknown[] = []) =>
  writeFileSync(ghReply, JSON.stringify({ number: 45, url: "https://pr/45", state, headRefOid, statusCheckRollup }), "utf8");
const { advancePipeline, watchPipelinePrs } = await import("./pipeline-advance");

type PaseoApi = PluginHandlerContext["paseo"];
type Agent = { id: string; cwd: string; workspaceId: string; labels: Record<string, string> };

const config: PipelineConfig = {
  enabled: true,
  phases: DEFAULT_PHASES,
  reviewRounds: 3,
  maxFixes: 3,
  closeOnMerge: true,
  sources: [],
};
const readConfig = async () => config;
const readAgentConfig = async () => FALLBACK_AGENT_CONFIG;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// A worktree whose Review passed and whose PR #45 is open, on a branch that pushes to a bare origin.
function fixture(ci: Record<string, unknown> = { pr: 45, url: "https://pr/45", fixedSha: null, attempts: 0 }) {
  const root = mkdtempSync(join(tmpdir(), "pipeline-repo-"));
  const cwd = join(root, "wt");
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", origin]);
  mkdirSync(join(cwd, ".harness"), { recursive: true });
  git(cwd, "init", "-q", "-b", "feature/abc-1");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  writeFileSync(join(cwd, ".gitignore"), ".harness/\n", "utf8");
  git(cwd, "add", ".gitignore");
  git(cwd, "commit", "-q", "-m", "start");
  git(cwd, "remote", "add", "origin", origin);
  git(cwd, "push", "-q", "-u", "origin", "feature/abc-1");
  writeFileSync(join(cwd, ".harness", "state.md"), "# ABC-1 — Demo\n\n## Status\npr-done\nhttps://pr/45\n", "utf8");
  writeFileSync(join(cwd, ".harness", "ci.json"), JSON.stringify(ci), "utf8");
  const labels = {
    jira: "ABC-1",
    kind: "session",
    pipeline: PIPELINE_LABEL,
    "jira-title": "Demo",
    "jira-url": "",
    phase: "review",
    round: "1",
  };
  return { cwd, origin, labels };
}

function fakePaseo(live: Agent[]) {
  const created: { title: string; labels: Record<string, string>; prompt?: string }[] = [];
  const api = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => {
          const found = live.find((agent) => agent.id === id);
          return found ? { agent: found } : null;
        },
      }),
      list: async () => ({ entries: live.map((agent) => ({ agent })) }),
    },
    workspaces: {
      ref: (workspaceId: string) => ({
        agents: {
          create: async (options: { title: string; labels: Record<string, string>; prompt?: string }) => {
            const id = `n${created.length + 1}`;
            created.push(options);
            live.push({ id, cwd: live[0].cwd, workspaceId, labels: options.labels });
            return { id };
          },
        },
      }),
    },
  };
  return { api: api as unknown as PaseoApi, created };
}

const readCi = (cwd: string) => JSON.parse(readFileSync(join(cwd, ".harness", "ci.json"), "utf8"));
const status = (cwd: string) =>
  readFileSync(join(cwd, ".harness", "state.md"), "utf8").split("## Status\n")[1].split("\n## ")[0].trim();

test("a failing PR head gets one Fix CI agent with the failing checks; the same head on the next tick gets none", async () => {
  const { cwd, labels } = fixture();
  const { api, created } = fakePaseo([{ id: "a1", cwd, workspaceId: "ws1", labels }]);
  ghPr("OPEN", "abc", [failedCheck]);

  await watchPipelinePrs(api, readConfig, readAgentConfig);
  await watchPipelinePrs(api, readConfig, readAgentConfig);

  assert.equal(created.length, 1);
  assert.deepEqual([created[0].labels.phase, created[0].labels.round, created[0].labels.jira], ["fix", "1", "ABC-1"]);
  assert.match(created[0].title, /Fix CI/);
  assert.match(created[0].prompt ?? "", /fix the failing CI checks \(attempt 1\)/);
  assert.match(created[0].prompt ?? "", /CI \/ test/);
  assert.deepEqual([readCi(cwd).fixedSha, readCi(cwd).attempts], ["abc", 1]);
});

test("a Fix CI agent's fix-done commits and pushes its change and puts the PR back under watch", async () => {
  const { cwd, origin, labels } = fixture({ pr: 45, url: "https://pr/45", fixedSha: "abc", attempts: 1 });
  const fixLabels = { ...labels, phase: "fix", round: "1" };
  const { api } = fakePaseo([{ id: "f1", cwd, workspaceId: "ws1", labels: fixLabels }]);
  writeFileSync(join(cwd, "meter.ts"), "export const meter = 2;\n", "utf8");
  writeFileSync(join(cwd, ".harness", "state.md"), "# ABC-1 — Demo\n\n## Status\nfix-done\nFix the meter rounding\n", "utf8");

  await advancePipeline(
    api,
    { agent: { id: "f1", cwd, workspaceId: "ws1" }, outcome: { kind: "completed" } } as never,
    readConfig,
    readAgentConfig,
  );

  assert.equal(git(origin, "log", "-1", "--format=%s", "feature/abc-1"), "Fix the meter rounding");
  assert.equal(status(cwd), "pr-done\nhttps://pr/45");
});

test("a new failing head after maxFixes attempts stops the watch with ci-failed and starts no agent", async () => {
  const { cwd, labels } = fixture({ pr: 45, url: "https://pr/45", fixedSha: "def", attempts: 3 });
  const { api, created } = fakePaseo([{ id: "a1", cwd, workspaceId: "ws1", labels }]);
  ghPr("OPEN", "ghi", [failedCheck]);

  await watchPipelinePrs(api, readConfig, readAgentConfig);

  assert.deepEqual(created, []);
  assert.equal(readCi(cwd).done, "gave-up");
  assert.equal(status(cwd), "ci-failed\nCI still failing after 3 fix attempts: CI / test");
});

test("a merged PR ends the watch; green and pending CI leave it running without an agent", async () => {
  const { cwd, labels } = fixture();
  const { api, created } = fakePaseo([{ id: "a1", cwd, workspaceId: "ws1", labels }]);

  ghPr("OPEN", "abc", []);
  await watchPipelinePrs(api, readConfig, readAgentConfig);
  assert.equal(readCi(cwd).done, undefined);

  ghPr("MERGED");
  await watchPipelinePrs(api, readConfig, readAgentConfig);
  assert.equal(readCi(cwd).done, "merged");
  assert.deepEqual(created, []);
});

const reviewed = (cwd: string, body: string) =>
  writeFileSync(join(cwd, ".harness", "state.md"), `# ABC-1 — Demo\n\n## Status\nreview-done\n\n## Review findings\n${body}\n`, "utf8");

test("pipeline review-done with an open non-blocking finding starts Implement round 2; at the limit a blocking one writes review-blocked", async () => {
  const { cwd, labels } = fixture();
  const { api, created } = fakePaseo([{ id: "r1", cwd, workspaceId: "ws1", labels }]);
  reviewed(cwd, "- [ ] non-blocking: b.ts:2 — unclear name — rename");

  await advancePipeline(api, { agent: { id: "r1", cwd, workspaceId: "ws1" }, outcome: { kind: "completed" } } as never, readConfig, readAgentConfig);

  assert.deepEqual(created.map((agent) => [agent.labels.phase, agent.labels.round]), [["implement", "2"]]);
  assert.match(created[0].prompt ?? "", /fix the review findings/);

  // Only the newest pipeline agent in a worktree moves the story on: here, the n1 the round above started.
  const last = { ...labels, round: String(config.reviewRounds) };
  const { api: later } = fakePaseo([{ id: "n1", cwd, workspaceId: "ws1", labels: last }]);
  reviewed(cwd, "- [ ] blocking: a.ts:1 — off by one — use <=");
  await advancePipeline(later, { agent: { id: "n1", cwd, workspaceId: "ws1" }, outcome: { kind: "completed" } } as never, readConfig, readAgentConfig);

  assert.equal(status(cwd), `review-blocked\nReview still has 1 blocking finding after ${config.reviewRounds} rounds; see ## Review findings in the worktree.`);
});
