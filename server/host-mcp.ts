import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import path from "node:path";

export type HostMcpServer =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      alwaysLoad?: boolean;
    }
  | {
      type: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
      alwaysLoad?: boolean;
    };

const ATLASSIAN_NAMES = ["mcp-atlassian", "atlassian", "jira"];

export async function readHostMcpServers(): Promise<Record<string, HostMcpServer>> {
  const servers: Record<string, HostMcpServer> = {};
  for (const [name, raw] of await loadNamedMcpServers()) {
    if (servers[name]) {
      continue;
    }
    const mapped = toPaseoMcpServer(raw);
    if (mapped) {
      servers[name] = mapped;
    }
  }
  return servers;
}

export async function readAtlassianMcpEnv(): Promise<Record<string, string | undefined>> {
  for (const [name, raw] of await loadNamedMcpServers()) {
    if (!isAtlassianName(name) && !jiraEnvFromServer(raw).JIRA_API_TOKEN) {
      continue;
    }
    const env = jiraEnvFromServer(raw);
    if (env.JIRA_URL && env.JIRA_USERNAME && env.JIRA_API_TOKEN) {
      return env;
    }
  }
  return {};
}

async function loadNamedMcpServers(): Promise<Array<[string, Record<string, unknown>]>> {
  const found: Array<[string, Record<string, unknown>]> = [];
  const seenFiles = new Set<string>();
  for (const file of await mcpConfigFiles()) {
    if (seenFiles.has(file)) {
      continue;
    }
    seenFiles.add(file);
    const parsed = await readJsonFile(file);
    if (parsed == null) {
      continue;
    }
    found.push(...walkNamedMcpServers(parsed));
  }
  return found;
}

async function mcpConfigFiles(): Promise<string[]> {
  const home = homedir();
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const appData = process.env.APPDATA;
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  const files = [
    path.join(home, ".cursor", "mcp.json"),
    path.join(home, ".claude.json"),
    ...(claudeConfigDir ? [path.join(claudeConfigDir, ".claude.json")] : []),
    path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    path.join(xdg, "Claude", "claude_desktop_config.json"),
    path.join(home, ".kiro", "settings", "mcp.json"),
    path.join(home, ".kiro", "mcp.json"),
    path.join(home, "Library", "Application Support", "Kiro", "User", "mcp.json"),
    path.join(xdg, "Kiro", "User", "mcp.json"),
    path.join(home, "Library", "Application Support", "Code", "User", "mcp.json"),
    path.join(xdg, "Code", "User", "mcp.json"),
    path.join(home, ".mcp.json"),
  ];
  if (appData) {
    files.push(
      path.join(appData, "Claude", "claude_desktop_config.json"),
      path.join(appData, "Kiro", "User", "mcp.json"),
      path.join(appData, "Code", "User", "mcp.json"),
    );
  }
  files.push(...(await projectMcpFiles()));
  return files;
}

async function projectMcpFiles(): Promise<string[]> {
  const roots = new Set<string>([process.cwd()]);
  for (const cwd of await paseoWorkspaceCwds()) {
    roots.add(cwd);
  }
  const files: string[] = [];
  for (const root of roots) {
    files.push(
      path.join(root, ".mcp.json"),
      path.join(root, ".cursor", "mcp.json"),
      path.join(root, ".kiro", "settings", "mcp.json"),
    );
  }
  return files;
}

async function paseoWorkspaceCwds(): Promise<string[]> {
  const home = process.env.PASEO_HOME ?? path.join(homedir(), ".paseo");
  const parsed = await readJsonFile(path.join(home, "projects", "workspaces.json"));
  if (!Array.isArray(parsed)) {
    return [];
  }
  const cwds: string[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    const cwd = asString(asRecord(entry)?.cwd);
    if (!cwd || seen.has(cwd)) {
      continue;
    }
    seen.add(cwd);
    cwds.push(cwd);
  }
  return cwds;
}

function walkNamedMcpServers(value: unknown, depth = 0): Array<[string, Record<string, unknown>]> {
  if (depth > 8 || value == null || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => walkNamedMcpServers(item, depth + 1));
  }
  const record = value as Record<string, unknown>;
  const found: Array<[string, Record<string, unknown>]> = [];
  for (const key of ["mcpServers", "servers"] as const) {
    const servers = asRecord(record[key]);
    if (!servers || !isMcpServerMap(servers)) {
      continue;
    }
    for (const [name, entry] of Object.entries(servers)) {
      const server = usableServer(asRecord(entry));
      if (server) {
        found.push([name, server]);
      }
    }
  }
  for (const child of Object.values(record)) {
    found.push(...walkNamedMcpServers(child, depth + 1));
  }
  return found;
}

function isMcpServerMap(servers: Record<string, unknown>) {
  return Object.values(servers).some((entry) => {
    const record = asRecord(entry);
    return Boolean(record && (asString(record.command) || asString(record.url)));
  });
}

function isAtlassianName(name: string) {
  return ATLASSIAN_NAMES.includes(name) || /atlassian|jira/i.test(name);
}

function usableServer(server: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!server || server.disabled === true) {
    return null;
  }
  return server;
}

function toPaseoMcpServer(raw: Record<string, unknown>): HostMcpServer | null {
  const command = asString(raw.command);
  if (command) {
    const args = Array.isArray(raw.args)
      ? raw.args.filter((value): value is string => typeof value === "string")
      : undefined;
    const envRecord = asRecord(raw.env);
    const env = envRecord
      ? Object.fromEntries(
          Object.entries(envRecord).flatMap(([key, value]) => {
            const text = expandEnv(asString(value));
            return text ? [[key, text] as const] : [];
          }),
        )
      : undefined;
    return { type: "stdio", command, args, env, alwaysLoad: true };
  }

  const url = asString(raw.url);
  if (!url) {
    return null;
  }
  const headersRecord = asRecord(raw.headers);
  const headers = headersRecord
    ? Object.fromEntries(
        Object.entries(headersRecord).flatMap(([key, value]) => {
          const text = expandEnv(asString(value));
          return text ? [[key, text] as const] : [];
        }),
      )
    : undefined;
  const kind = asString(raw.type) === "sse" || url.includes("/sse") ? "sse" : "http";
  return { type: kind, url, headers, alwaysLoad: true };
}

function jiraEnvFromServer(server: Record<string, unknown>): Record<string, string | undefined> {
  const env = asRecord(server.env) ?? {};
  const url = firstEnv(env, ["JIRA_URL", "ATLASSIAN_JIRA_URL", "JIRA_BASE_URL", "JIRA_HOST"]);
  const username = firstEnv(env, [
    "JIRA_USERNAME",
    "JIRA_EMAIL",
    "ATLASSIAN_EMAIL",
    "ATLASSIAN_USERNAME",
    "JIRA_USER",
  ]);
  const token = firstEnv(env, ["JIRA_API_TOKEN", "JIRA_TOKEN", "ATLASSIAN_API_TOKEN", "JIRA_API_KEY"]);
  return {
    JIRA_URL: normalizeJiraUrl(url),
    JIRA_USERNAME: username,
    JIRA_API_TOKEN: token,
  };
}

function firstEnv(env: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = expandEnv(asString(env[key]));
    if (value) {
      return value;
    }
  }
  return undefined;
}

function normalizeJiraUrl(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function expandEnv(value: string | null) {
  if (!value) {
    return undefined;
  }
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, name: string) => process.env[name] ?? "");
}

async function readJsonFile(file: string): Promise<unknown | null> {
  try {
    return parseJsonc(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function parseJsonc(text: string): unknown {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,\s*([}\]])/g, "$1")
    .trim();
  if (!stripped) {
    return null;
  }
  return JSON.parse(stripped);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
