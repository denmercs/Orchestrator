import assert from "node:assert/strict";
import { test } from "node:test";
import { pickMcpServers, type HostMcpServer } from "./host-mcp";
import { registerMcpScopeRpc } from "../shared/orchestration";
import { MCP_SCOPE_TTL_MS, mcpScopeFor, registerMcpScope, scopeWorkerWorkspace, withMcpScope } from "./mcp-scope";
import { WORKER_MARK } from "../shared/marks";

const servers: Record<string, HostMcpServer> = {
  "google-calendar": { type: "stdio", command: "npx" },
  "mcp-atlassian": { type: "stdio", command: "uvx" },
  "com.atlassian/atlassian-mcp-server": { type: "http", url: "https://mcp.atlassian.com/v1/sse" },
  sentry: { type: "http", url: "https://mcp.sentry.dev/mcp" },
};

test("all keeps every host server, none keeps nothing", () => {
  assert.equal(pickMcpServers(servers, "all"), servers);
  assert.deepEqual(pickMcpServers(servers, "none"), {});
});

test("jira keeps a single Atlassian server", () => {
  assert.deepEqual(Object.keys(pickMcpServers(servers, "jira")), ["mcp-atlassian"]);
  assert.deepEqual(pickMcpServers({ sentry: servers.sentry }, "jira"), {});
});

test("a folder's scope holds only while its agent is being created", async () => {
  assert.equal(mcpScopeFor("/work/tree"), "all");
  const seen = await withMcpScope("/work/tree/", "none", async () => mcpScopeFor("/work/tree"));
  assert.equal(seen, "none");
  assert.equal(mcpScopeFor("/work/tree"), "all");
});

test("the scope is cleared even when creating the agent fails", async () => {
  await assert.rejects(
    withMcpScope("/work/fails", "jira", async () => {
      throw new Error("boom");
    }),
  );
  assert.equal(mcpScopeFor("/work/fails"), "all");
});

test("agents with no folder and folders nobody registered keep every server", async () => {
  assert.equal(mcpScopeFor(null), "all");
  assert.equal(await withMcpScope(null, "none", async () => mcpScopeFor(null)), "all");
});

test("a registered scope holds for the agent created right after it", () => {
  const t0 = 1_000_000;
  registerMcpScope({ cwd: "/w/a", scope: "jira" }, t0);
  assert.equal(mcpScopeFor("/w/a/", t0 + 1000), "jira");
});

test("a registered scope expires when no agent is created, and the entry is dropped", () => {
  const t0 = 2_000_000;
  registerMcpScope({ cwd: "/w/b", scope: "jira" }, t0);
  assert.equal(mcpScopeFor("/w/b", t0 + MCP_SCOPE_TTL_MS + 1), "all");
  assert.equal(mcpScopeFor("/w/b", t0), "all");
});

test("a folder nobody registered still gets every server", () => {
  registerMcpScope({ cwd: "/w/c", scope: "jira" }, 3_000_000);
  assert.equal(mcpScopeFor("/w/unregistered", 3_000_000), "all");
});

test("the register RPC's input goes straight to registerMcpScope", () => {
  const t0 = 4_000_000;
  registerMcpScope(registerMcpScopeRpc.input.parse({ cwd: "/w/rpc", scope: "jira" }), t0);
  assert.equal(mcpScopeFor("/w/rpc", t0 + 1000), "jira");
});

test("the register RPC can only remove servers, so it rejects scope all", () => {
  assert.equal(registerMcpScopeRpc.input.safeParse({ cwd: "/w/rpc", scope: "all" }).success, false);
});

test("a workspace the epic parent names as a worker gets the jira scope for its agent", () => {
  const t0 = 4_000_000;
  scopeWorkerWorkspace({ cwd: "/w/child", name: `${WORKER_MARK} QUICK-2 — Child` }, t0);
  assert.equal(mcpScopeFor("/w/child", t0 + 1000), "jira");
  assert.equal(mcpScopeFor("/w/child", t0 + MCP_SCOPE_TTL_MS + 1), "all");
});

test("workspaces without the worker mark keep every server", () => {
  const t0 = 5_000_000;
  scopeWorkerWorkspace({ cwd: "/w/mine", name: "My own work" }, t0);
  scopeWorkerWorkspace({ cwd: "/w/untitled", name: null }, t0);
  assert.equal(mcpScopeFor("/w/mine", t0), "all");
  assert.equal(mcpScopeFor("/w/untitled", t0), "all");
});

test("registering prunes expired entries, so a create that never happens leaves nothing behind", () => {
  const t0 = 6_000_000;
  registerMcpScope({ cwd: "/w/never", scope: "jira" }, t0);
  registerMcpScope({ cwd: "/w/later", scope: "jira" }, t0 + MCP_SCOPE_TTL_MS + 1);
  assert.equal(mcpScopeFor("/w/never", t0), "all");
});
