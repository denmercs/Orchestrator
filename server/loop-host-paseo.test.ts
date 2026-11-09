import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginHandlerContext, PluginHookAgent, PluginTurnOutcome } from "@getpaseo/plugin/server";
import { loopPermissionRequested, loopPermissionResolved, loopTurnEnded, paseoLoopHost } from "./loop-host-paseo";

type Paseo = PluginHandlerContext["paseo"];

// The host over a handle that has only the pieces a test gives it.
const hostOver = (handle: unknown) => paseoLoopHost(handle as Paseo);

test("listProjects is empty when the handle has no projects API", async () => {
  // The daemon this was seen on answered "Cannot read properties of undefined (reading 'list')".
  assert.deepEqual(await hostOver({}).listProjects(), []);
});

test("listProjects is empty when the list call rejects, and passes the projects through when it answers", async () => {
  const failing = { projects: { list: async () => Promise.reject(new Error("daemon down")) } };
  assert.deepEqual(await hostOver(failing).listProjects(), []);

  const projects = [{ projectId: "p1", projectRootPath: "/repo" }];
  assert.deepEqual(await hostOver({ projects: { list: async () => ({ projects }) } }).listProjects(), projects);
});

test("listWorkspaces maps each workspace to its folder and project root, and marks busy the ones with a running or initializing agent", async () => {
  // Arrange: three workspaces; agents running in w1, initializing in w3, idle or archived-free elsewhere.
  const host = hostOver({
    workspaces: {
      list: async () => ({
        entries: [
          { id: "w1", projectId: "p1", workspaceDirectory: "/wt/one", projectRootPath: "/repo" },
          { id: "w2", projectId: "p1", workspaceDirectory: "/wt/two", projectRootPath: "/repo" },
          { id: "w3", projectId: "p2", workspaceDirectory: undefined, projectRootPath: "/other" },
          { id: "w4", projectId: "p3", workspaceDirectory: "/wt/four" },
        ],
      }),
    },
    projects: { list: async () => ({ projects: [{ projectId: "p3", projectRootPath: "/third" }] }) },
    agents: {
      list: async () => ({
        entries: [
          { agent: { id: "a1", status: "running", workspaceId: "w1" } },
          { agent: { id: "a2", status: "idle", workspaceId: "w2" } },
          { agent: { id: "a3", status: "initializing", workspaceId: "w3" } },
          { agent: { id: "a4", status: "running", workspaceId: undefined } },
        ],
      }),
    },
  });

  // Act
  const listed = await host.listWorkspaces();

  // Assert: busy only for running or initializing; a missing folder is "", a missing root comes from the project list.
  assert.deepEqual(listed, [
    { id: "w1", directory: "/wt/one", projectRootPath: "/repo", busy: true },
    { id: "w2", directory: "/wt/two", projectRootPath: "/repo", busy: false },
    { id: "w3", directory: "", projectRootPath: "/other", busy: true },
    { id: "w4", directory: "/wt/four", projectRootPath: "/third", busy: false },
  ]);
});

test("listWorkspaces is empty when the handle has no workspaces API or the list call rejects", async () => {
  assert.deepEqual(await hostOver({}).listWorkspaces(), []);
  const failing = { workspaces: { list: async () => Promise.reject(new Error("daemon down")) }, agents: { list: async () => ({ entries: [] }) } };
  assert.deepEqual(await hostOver(failing).listWorkspaces(), []);
});

test("sendToStep passes the steer option through to the agent's send", async () => {
  const calls: { id: string; text: string; options: unknown }[] = [];
  const host = hostOver({
    agents: {
      ref: (id: string) => ({
        send: async (text: string, options: unknown) => {
          calls.push({ id, text, options });
        },
      }),
    },
  });

  await host.sendToStep("a1", "keep going", { activeTurnBehavior: "steer" });

  assert.deepEqual(calls, [{ id: "a1", text: "keep going", options: { activeTurnBehavior: "steer" } }]);
});

test("refreshSession is undefined when the refresh throws, null when the agent is gone, and the session when it answers", async () => {
  const refreshing = (refresh: () => Promise<unknown>) => hostOver({ agents: { ref: () => ({ refresh }) } });

  assert.equal(await refreshing(async () => Promise.reject(new Error("daemon down"))).refreshSession("a1"), undefined);
  assert.equal(await refreshing(async () => null).refreshSession("a1"), null);

  const session = await refreshing(async () => ({ agent: { id: "a1", status: "idle", labels: { kind: "initiative-loop" } } })).refreshSession("a1");
  assert.deepEqual(session, {
    id: "a1",
    status: "idle",
    archivedAt: undefined,
    lastError: undefined,
    labels: { kind: "initiative-loop" },
    activeTurn: null,
    lastUsage: undefined,
  });
});

test("loopTurnEnded carries the agent id and timeline, and a failed turn's error as its message", () => {
  const agent = { id: "a1" } as PluginHookAgent;
  const timeline = [{ type: "user_message" }];

  assert.deepEqual(loopTurnEnded({ agent, outcome: { kind: "completed" }, timeline }), { agentId: "a1", outcome: { kind: "completed" }, timeline });
  assert.deepEqual(loopTurnEnded({ agent, outcome: { kind: "canceled", reason: "user" } as PluginTurnOutcome }).outcome, { kind: "canceled" });
  const failed = { kind: "failed", error: { message: "rate limited" } } as unknown as PluginTurnOutcome;
  assert.deepEqual(loopTurnEnded({ agent, outcome: failed }).outcome, { kind: "failed", message: "rate limited" });
});

test("loopPermissionRequested and loopPermissionResolved carry the agent id and the request's name and title", () => {
  const agent = { id: "a1" } as PluginHookAgent;

  assert.deepEqual(loopPermissionRequested({ agent, request: { name: "Bash", title: "Run ls", extra: 1 } as never }), {
    agentId: "a1",
    request: { name: "Bash", title: "Run ls" },
  });
  assert.deepEqual(loopPermissionResolved({ agent }), { agentId: "a1" });
});

test("createStoryWorkspace asks for a branch-off worktree, and takes the folder from the created workspace's refresh when it has none", async () => {
  const requests: unknown[] = [];
  const host = hostOver({
    workspaces: {
      create: async (request: unknown) => {
        requests.push(request);
        return { id: "w1", directory: undefined, refresh: async () => ({ workspaceDirectory: "/wt/one" }) };
      },
    },
  });

  const created = await host.createStoryWorkspace({
    title: "S1",
    repoRoot: "/repo",
    projectId: "p1",
    baseBranch: "main",
    branchName: "s1",
    worktreeSlug: "s1",
  });

  assert.deepEqual(created, { id: "w1", directory: "/wt/one" });
  assert.deepEqual(requests, [
    { title: "S1", source: { kind: "worktree", cwd: "/repo", projectId: "p1", action: "branch-off", baseBranch: "main", branchName: "s1", worktreeSlug: "s1" } },
  ]);
});

test("createStoryWorkspace leaves out a missing projectId, and takes the created folder without a refresh", async () => {
  const requests: unknown[] = [];
  let refreshed = 0;
  const host = hostOver({
    workspaces: {
      create: async (request: unknown) => {
        requests.push(request);
        return { id: "w1", directory: "/wt/one", refresh: async () => (refreshed++, null) };
      },
    },
  });

  const created = await host.createStoryWorkspace({ title: "S1", repoRoot: "/repo", baseBranch: "main", branchName: "s1", worktreeSlug: "s1" });

  assert.deepEqual(created, { id: "w1", directory: "/wt/one" });
  assert.equal(refreshed, 0);
  assert.deepEqual(requests, [
    { title: "S1", source: { kind: "worktree", cwd: "/repo", action: "branch-off", baseBranch: "main", branchName: "s1", worktreeSlug: "s1" } },
  ]);
  assert.equal(Object.hasOwn((requests[0] as { source: object }).source, "projectId"), false);
});

test("createStoryWorkspace throws when Paseo reports no folder", async () => {
  const host = hostOver({
    workspaces: {
      create: async () => ({ id: "w1", directory: undefined, refresh: async () => null }),
    },
  });

  await assert.rejects(
    host.createStoryWorkspace({ title: "S1", repoRoot: "/repo", baseBranch: "main", branchName: "s1", worktreeSlug: "s1" }),
    /did not report its folder/,
  );
});

test("timelineTail asks for the projected tail and returns null when the read throws", async () => {
  const asked: unknown[] = [];
  const answering = hostOver({
    agents: { ref: (id: string) => ({ timeline: { refetch: async (query: unknown) => (asked.push({ id, query }), { entries: [{ type: "x" }], error: null }) } }) },
  });
  const throwing = hostOver({ agents: { ref: () => ({ timeline: { refetch: async () => Promise.reject(new Error("daemon down")) } }) } });

  assert.deepEqual(await answering.timelineTail("a1", { limit: 5 }), { entries: [{ type: "x" }], error: null });
  assert.deepEqual(asked, [{ id: "a1", query: { direction: "tail", limit: 5, projection: "projected" } }]);
  assert.equal(await throwing.timelineTail("a1", { limit: 5 }), null);
});

test("timelineTail passes a page's error through, so the caller can tell a partial read", async () => {
  const host = hostOver({ agents: { ref: () => ({ timeline: { refetch: async () => ({ entries: [], error: "timeline unavailable" }) } }) } });

  assert.deepEqual(await host.timelineTail("a1", { limit: 50 }), { entries: [], error: "timeline unavailable" });
});

test("listStepAgents maps each live agent to a session, with defaults for what Paseo leaves out", async () => {
  const asked: unknown[] = [];
  const host = hostOver({
    agents: {
      list: async (query: unknown) => {
        asked.push(query);
        return {
          entries: [
            { agent: { id: "a1", status: "running", archivedAt: null, lastError: null, labels: undefined, activeTurn: null, lastUsage: null } },
            { agent: { id: "a2", status: "idle", archivedAt: "2026-01-01", lastError: "boom", labels: { kind: "x" }, activeTurn: { id: "t" }, lastUsage: { tokens: 1 } } },
          ],
        };
      },
    },
  });

  const sessions = await host.listStepAgents();

  assert.deepEqual(asked, [{ filter: { includeArchived: false }, page: { limit: 200 } }]);
  assert.deepEqual(sessions, [
    { id: "a1", status: "running", archivedAt: undefined, lastError: undefined, labels: {}, activeTurn: null, lastUsage: undefined },
    { id: "a2", status: "idle", archivedAt: "2026-01-01", lastError: "boom", labels: { kind: "x" }, activeTurn: { id: "t" }, lastUsage: { tokens: 1 } },
  ]);
});

test("archiveStoryWorkspace archives the workspace and swallows a refusal", async () => {
  const archived: string[] = [];
  const host = hostOver({
    workspaces: { archive: async (id: string) => (id === "gone" ? Promise.reject(new Error("no such workspace")) : void archived.push(id)) },
  });

  await host.archiveStoryWorkspace("w1");
  await host.archiveStoryWorkspace("gone");

  assert.deepEqual(archived, ["w1"]);
});
