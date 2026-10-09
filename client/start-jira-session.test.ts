import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardItem } from "./board-model";
import { WORKER_MARK, repoForKey, startJiraSession } from "./start-jira-session";

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

function fakePaseo(
  directory: string | null,
  calls: string[],
  prompts: string[] = [],
  sources: unknown[] = [],
) {
  const paseo = {
    projects: {
      list: async () => ({
        projects: [
          {
            projectId: "p1",
            projectDisplayName: "quickpress",
            projectRootPath: "/repo",
          },
        ],
      }),
    },
    workspaces: {
      create: async (input: { source: unknown }) => {
        sources.push(input.source);
        return {
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
        };
      },
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

test("the pipeline path never registers a scope from the client", async () => {
  const calls: string[] = [];
  await startJiraSession(
    fakePaseo("/worktrees/quick-1", calls),
    boardItem("story"),
    async () => ({ agentId: "pipeline", warnings: [] }),
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

test("the epic prompt titles each child workspace as a worker when it is created", async () => {
  const prompts: string[] = [];
  await startJiraSession(
    fakePaseo("/worktrees/quick-1", [], prompts),
    boardItem("epic"),
  );
  assert.match(
    prompts[0] ?? "",
    new RegExp(`create_workspace.*title "${WORKER_MARK} <KEY> — <summary>"`),
  );
  assert.match(
    prompts[0] ?? "",
    /then immediately create the subagent in that workspace \(pass its workspaceId to create_agent\)/,
  );
});

test("a failed scope registration still creates the agent and warns", async () => {
  const calls: string[] = [];
  const result = await startJiraSession(
    fakePaseo("/worktrees/quick-1", calls),
    boardItem("story"),
    undefined,
    undefined,
    async () => {
      throw new Error("rpc down");
    },
  );
  assert.deepEqual(calls, ["agents.create"]);
  assert.deepEqual(result.warnings, [
    "MCP scope not applied; this session gets every host server.",
  ]);
});

for (const [initials, branch] of [
  ["dm", "dm/quick-1/do-the-thing"],
  [null, "quick-1/do-the-thing"],
] as const) {
  test(`the branch is ${branch} with initials ${initials}; the folder slug is unchanged`, async () => {
    const sources: unknown[] = [];
    await startJiraSession(
      fakePaseo("/worktrees/quick-1", [], [], sources),
      boardItem("story"),
      undefined,
      undefined,
      undefined,
      initials,
    );
    assert.partialDeepStrictEqual(sources[0], {
      branchName: branch,
      worktreeSlug: "quick-1-do-the-thing",
    });
  });
}

test("a Start before the initials load waits for them instead of dropping the prefix", async () => {
  const sources: unknown[] = [];
  let resolve: (value: string | null) => void = () => {};
  const pending = new Promise<string | null>((done) => (resolve = done));
  const started = startJiraSession(
    fakePaseo("/worktrees/quick-1", [], [], sources),
    boardItem("story"),
    undefined,
    undefined,
    undefined,
    pending,
  );
  resolve("dm");
  await started;
  assert.partialDeepStrictEqual(sources[0], { branchName: "dm/quick-1/do-the-thing" });
});

type ProjectList = Parameters<typeof repoForKey>[0];

const listedProjects = {
  projects: [
    { projectId: "p0", projectDisplayName: "orchestrator", projectRootPath: "/repos/orchestrator" },
    { projectId: "p1", projectDisplayName: "quickpress", projectRootPath: "/repos/quickpress" },
  ],
} as unknown as ProjectList;

test("a QUICK key resolves to the quickpress project's root path", () => {
  assert.equal(repoForKey(listedProjects, "QUICK-12", "/repos/harness"), "/repos/quickpress");
});

test("an unknown prefix falls back to the given harness repo", () => {
  assert.equal(repoForKey(listedProjects, "NOPE-3", "/repos/harness"), "/repos/harness");
});

test("no match and no fallback gives null", () => {
  assert.equal(repoForKey(listedProjects, "NOPE-3", null), null);
});
