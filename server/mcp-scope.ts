import { resolve } from "node:path";
import type { McpScope } from "./host-mcp";

// The agent.create hook only sees the new agent's config, not its labels, so the code that starts
// a plugin agent records the scope for the agent's folder first and the hook looks it up by cwd.
// Agents the plugin did not start (your own sessions) are not listed and keep every host server.
const scopes = new Map<string, McpScope>();

export async function withMcpScope<T>(cwd: string | null | undefined, scope: McpScope, create: () => Promise<T>) {
  if (!cwd) {
    return create();
  }
  const key = resolve(cwd);
  scopes.set(key, scope);
  try {
    return await create();
  } finally {
    if (scopes.get(key) === scope) {
      scopes.delete(key);
    }
  }
}

export function mcpScopeFor(cwd: string | null | undefined): McpScope {
  return (cwd ? scopes.get(resolve(cwd)) : undefined) ?? "all";
}
