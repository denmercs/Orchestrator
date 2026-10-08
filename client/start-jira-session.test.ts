import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardItem } from "./board-model";
import { startJiraSession } from "./start-jira-session";

type StartArgs = Parameters<typeof startJiraSession>;

function boardItem(role: BoardItem["role"]): BoardItem {
  return {
    id: "QUICK-1",
    key: "QUICK-1",
    title: "Do the thing",
    detail: "",
    underTitle: null,
    phaseId: "ready" as BoardItem["phaseId"],
    phaseLabel: "",
    pr: null,
    retryLabel: null,
    progress: null,
    agentId: null,
    workspaceId: null,
    isMainSession: true,
    role,
    url: null,
    source: "jira",
    parentKey: null,
    completed: false,
    startLabel: "Start session",
  };
}

function fakePaseo(directory: string | null, calls: string[], prompts: string[] = []) {
  const paseo = {
    projects: {
      list: async () => ({
        projects: [{ projectId: "p1", projectDisplayName: "quickpress", projectRootPath: "/repo" }],
      }),
    },
    workspaces: {
      create: async () => ({
        id: "w1",
        directory,
        setTitle: async () => {},
        agents: {
          create: async (input: { prompt: string }) => {
            calls.push("agents.create");
            prompts.push(input.prompt);
            return { id: "a1" };
          },
        },
      }),
    },
  };
  return paseo as unknown as StartArgs[0];
}

for (const role of ["story", "epic"] as const) {
  test(`a ${role} registers the jira scope for its folder before the agent is created`, async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    const scopes: unknown[] = [];
    const result = await startJiraSession(
      fakePaseo("/worktrees/quick-1", calls, prompts),
      boardItem(role),
      undefined,
      undefined,
      async (input) => {
        calls.push("registerScope");
        scopes.push(input);
        return { ok: true };
      },
    );
    assert.deepEqual(calls, ["registerScope", "agents.create"]);
    assert.deepEqual(scopes, [{ cwd: "/worktrees/quick-1", scope: "jira" }]);
    assert.deepEqual(result.warnings, []);
    assert.match(prompts[0] ?? "", /Jira\/Atlassian MCP tools/);
    assert.doesNotMatch(prompts[0] ?? "", /GitHub|Sentry/);
  });
}

test("the belt path never registers a scope from the client", async () => {
  const calls: string[] = [];
  await startJiraSession(
    fakePaseo("/worktrees/quick-1", calls),
    boardItem("story"),
    async () => ({ agentId: "belt", warnings: [] }),
    undefined,
    async () => {
      calls.push("registerScope");
      return { ok: true };
    },
  );
  assert.deepEqual(calls, []);
});

test("an unknown workspace folder skips registering and warns", async () => {
  const calls: string[] = [];
  const result = await startJiraSession(
    fakePaseo(null, calls),
    boardItem("epic"),
    undefined,
    undefined,
    async () => {
      calls.push("registerScope");
      return { ok: true };
    },
  );
  assert.deepEqual(calls, ["agents.create"]);
  assert.deepEqual(result.warnings, [
    "MCP scope not applied; this session gets every host server.",
  ]);
});
