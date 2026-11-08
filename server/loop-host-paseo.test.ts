import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { paseoLoopHost } from "./loop-host-paseo";

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
