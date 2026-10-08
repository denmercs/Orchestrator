import assert from "node:assert/strict";
import { test } from "node:test";
import { pickMcpServers, type HostMcpServer } from "./host-mcp";
import { MCP_SCOPE_TTL_MS, mcpScopeFor, registerMcpScope, withMcpScope } from "./mcp-scope";

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
