import { resolve } from "node:path";
import { WORKER_MARK } from "../shared/marks";
import type { McpScope } from "./host-mcp";

// The agent.create hook only sees the new agent's config, not its labels, so the code that starts
// a plugin agent records the scope for the agent's folder first and the hook looks it up by cwd.
// Agents the plugin did not start (your own sessions) are not listed and keep every host server.
// Scopes registered ahead of a create the server does not run (the client's) expire, so a create
// that never happens can't leave a stale entry; withMcpScope entries never expire.
export const MCP_SCOPE_TTL_MS = 60_000;

const scopes = new Map<string, { scope: McpScope; expiresAt: number }>();

export async function withMcpScope<T>(cwd: string | null | undefined, scope: McpScope, create: () => Promise<T>) {
  if (!cwd) {
    return create();
  }
  const key = resolve(cwd);
  const entry = { scope, expiresAt: Infinity };
  scopes.set(key, entry);
  try {
    return await create();
  } finally {
    if (scopes.get(key) === entry) {
      scopes.delete(key);
    }
  }
}

export function registerMcpScope(input: { cwd: string; scope: McpScope }, now = Date.now()) {
  for (const [key, entry] of scopes) {
    if (entry.expiresAt < now) {
      scopes.delete(key);
    }
  }
  scopes.set(resolve(input.cwd), { scope: input.scope, expiresAt: now + MCP_SCOPE_TTL_MS });
}

// The epic parent creates each child's workspace with the worker title before its agent, so the
// workspace.created event can scope that folder the same way the board does for its own sessions.
export function scopeWorkerWorkspace(workspace: { cwd: string; name: string | null }, now = Date.now()) {
  if (workspace.name?.startsWith(WORKER_MARK)) {
    registerMcpScope({ cwd: workspace.cwd, scope: "jira" }, now);
  }
}

export function mcpScopeFor(cwd: string | null | undefined, now = Date.now()): McpScope {
  if (!cwd) {
    return "all";
  }
  const key = resolve(cwd);
  const entry = scopes.get(key);
  if (entry && entry.expiresAt < now) {
    scopes.delete(key);
    return "all";
  }
  return entry?.scope ?? "all";
}
