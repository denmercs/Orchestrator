import { execFile } from "node:child_process";
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

// Which host servers an agent gets. Loop and pipeline agents that only touch the worktree get none;
// steps that read a ticket get one Atlassian server. Every server's tool list rides along on each
// model call, so this is the main lever on per-turn context size.
export type McpScope = "all" | "jira" | "none";

export function pickMcpServers(servers: Record<string, HostMcpServer>, scope: McpScope) {
  if (scope === "all") {
    return servers;
  }
  if (scope === "none") {
    return {};
  }
  // Two Atlassian servers carry the same tools; the first one found is enough.
  const jira = Object.keys(servers).find(isAtlassianName);
  return jira ? { [jira]: servers[jira] } : {};
}

// Returned env/headers hold live credentials (API tokens, auth headers). Never log or return them over RPC.
// Servers that ~/.claude.json scopes to a project attach only when `cwd` is inside that project.
export async function readHostMcpServers(cwd?: string | null): Promise<Record<string, HostMcpServer>> {
  const folders = cwd ? await agentFolders(cwd) : [];
  const servers: Record<string, HostMcpServer> = {};
  for (const { name, raw, project } of await loadNamedMcpServers()) {
    if (servers[name] || (project && !isInsideProject(project, folders))) {
      continue;
    }
    const mapped = toPaseoMcpServer(raw);
    if (mapped) {
      servers[name] = mapped;
    }
  }
  return servers;
}

// Contains JIRA_API_TOKEN. Same rule as above.
export async function readAtlassianMcpEnv(): Promise<Record<string, string | undefined>> {
  // Project scope is ignored here: Jira credentials count wherever they are defined.
  for (const { name, raw } of await loadNamedMcpServers()) {
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

// True when any of `folders` is `project` or sits under it. `/x/lifeway` does not contain
// `/x/lifeway-discipleship`.
export function isInsideProject(project: string, folders: string[]) {
  const root = path.resolve(project);
  return folders.some((folder) => {
    const resolved = path.resolve(folder);
    return resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  });
}

// For a linked worktree, the folder in the main checkout at the same relative spot as `cwd`.
// Null for a plain checkout, or when the common dir is bare and has no checkout beside it.
export function mainCheckoutPath(cwd: string, toplevel: string, commonDir: string): string | null {
  const common = path.resolve(commonDir);
  if (path.basename(common) !== ".git") {
    return null;
  }
  const main = path.dirname(common);
  const top = path.resolve(toplevel);
  if (top === main) {
    return null;
  }
  return path.join(main, path.relative(top, path.resolve(cwd)));
}

type NamedMcpServer = { name: string; raw: Record<string, unknown>; project?: string };

// `cwd`, plus its spot in the main checkout when it is a git worktree. Any git failure means just `cwd`.
function agentFolders(cwd: string): Promise<string[]> {
  return new Promise((done) => {
    execFile(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
      { cwd, timeout: 5_000 },
      (error, stdout) => {
        const [commonDir, toplevel] = error ? [] : stdout.trim().split("\n");
        const main = commonDir && toplevel ? mainCheckoutPath(cwd, toplevel, commonDir) : null;
        done(main ? [cwd, main] : [cwd]);
      },
    );
  });
}

async function loadNamedMcpServers(): Promise<NamedMcpServer[]> {
  const found: NamedMcpServer[] = [];
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
    found.push(...(path.basename(file) === ".claude.json" ? walkClaudeJson(parsed) : walkAll(parsed)));
  }
  return found;
}

function walkAll(value: unknown, project?: string): NamedMcpServer[] {
  return walkNamedMcpServers(value).map(([name, raw]) => (project ? { name, raw, project } : { name, raw }));
}

// Claude Code keeps per-project servers under `projects[<path>].mcpServers`; tag them with their path.
function walkClaudeJson(value: unknown): NamedMcpServer[] {
  const record = asRecord(value);
  if (!record) {
    return walkAll(value);
  }
  const { projects, ...rest } = record;
  const found = walkAll(rest);
  for (const [project, entry] of Object.entries(asRecord(projects) ?? {})) {
    found.push(...walkAll(entry, project));
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
    return { type: "stdio", command, args, env };
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
  return { type: kind, url, headers };
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
  return value.replace(/\$\{(?:env:)?([A-Z0-9_]+)\}/gi, (_match, name: string) => process.env[name] ?? "");
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
