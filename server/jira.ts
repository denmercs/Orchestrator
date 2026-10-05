import type { RpcOutput } from "@getpaseo/plugin";
import {
  getJiraBoard,
  listJiraBoards,
  type JiraBoardOption,
  type JiraIssue,
} from "../shared/orchestration";
import { readAtlassianMcpEnv } from "./host-mcp";

const DEFAULT_PROJECT = "QUICK";
const DEFAULT_BOARD_NAME = "QuickPress";
const ACTIVE_LIMIT = 50;
const DONE_LIMIT = 12;
const PARENT_LIMIT = 40;

type JiraCredentials = {
  url: string;
  username: string;
  token: string;
};

type RawIssue = {
  id?: unknown;
  key?: unknown;
  fields?: Record<string, unknown> | null;
};

export async function listAccessibleJiraBoards(): Promise<RpcOutput<typeof listJiraBoards>> {
  try {
    const credentials = await resolveCredentials();
    return { boards: await fetchBoards(credentials), error: null };
  } catch (error) {
    return { boards: [], error: publicError(error) };
  }
}

export async function loadJiraBoard(
  input: { boardId?: string; projectKey?: string } = {},
): Promise<RpcOutput<typeof getJiraBoard>> {
  try {
    const credentials = await resolveCredentials();
    const selected = await resolveBoard(credentials, input);
    const issues = await fetchBoardIssues(credentials, selected.projectKey);
    return { ...selected, issues, error: null };
  } catch (error) {
    const projectKey = (input.projectKey ?? DEFAULT_PROJECT).toUpperCase();
    return {
      boardId: input.boardId ?? null,
      name: projectKey === DEFAULT_PROJECT ? DEFAULT_BOARD_NAME : projectKey,
      projectKey,
      issues: [],
      error: publicError(error),
    };
  }
}

async function fetchBoardIssues(
  credentials: JiraCredentials,
  projectKey: string,
): Promise<JiraIssue[]> {
  const [active, done] = await Promise.all([
    searchIssues(
      credentials,
      `project = ${projectKey} AND (status in ("In Progress","Selected For Development") OR (statusCategory != Done AND updated >= -21d)) ORDER BY updated DESC`,
      ACTIVE_LIMIT,
    ),
    searchIssues(
      credentials,
      `project = ${projectKey} AND statusCategory = Done AND updated >= -7d ORDER BY updated DESC`,
      DONE_LIMIT,
    ),
  ]);
  const byKey = new Map([...done, ...active].map((issue) => [issue.key, issue]));
  const missingParents = [
    ...new Set(
      [...active, ...done]
        .map((issue) => issue.parentKey)
        .filter((key): key is string => key != null && !byKey.has(key)),
    ),
  ].slice(0, PARENT_LIMIT);

  if (missingParents.length > 0) {
    const parents = await searchIssues(
      credentials,
      `key in (${missingParents.join(",")})`,
      missingParents.length,
    );
    for (const parent of parents) {
      byKey.set(parent.key, parent);
    }
  }

  return [...byKey.values()];
}

async function searchIssues(
  credentials: JiraCredentials,
  jql: string,
  limit: number,
): Promise<JiraIssue[]> {
  const issues: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  let startAt = 0;

  while (issues.length < limit) {
    const remaining = limit - issues.length;
    const payload: Record<string, unknown> = {
      jql,
      maxResults: Math.min(50, remaining),
      fields: ["summary", "status", "issuetype", "assignee", "parent", "labels", "updated"],
    };
    if (nextPageToken) {
      payload.nextPageToken = nextPageToken;
    } else if (startAt > 0) {
      payload.startAt = startAt;
    }

    const body = await jiraRequest(credentials, payload);
    const page = Array.isArray(body.issues) ? body.issues : [];
    for (const raw of page) {
      const issue = normalizeIssue(raw, credentials.url);
      if (issue) {
        issues.push(issue);
      }
    }

    const token = asString(body.nextPageToken);
    if (token) {
      nextPageToken = token;
      continue;
    }

    startAt += page.length;
    const total = typeof body.total === "number" ? body.total : issues.length;
    if (page.length === 0 || startAt >= total || issues.length >= limit) {
      break;
    }
  }

  return issues;
}

async function fetchBoards(credentials: JiraCredentials): Promise<JiraBoardOption[]> {
  const boards: JiraBoardOption[] = [];
  let startAt = 0;

  while (boards.length < 50) {
    const body = await jiraGet(
      credentials,
      `/rest/agile/1.0/board?startAt=${startAt}&maxResults=50`,
    );
    const page = Array.isArray(body.values) ? body.values : [];
    for (const raw of page) {
      const board = normalizeBoard(raw);
      if (board) {
        boards.push(board);
      }
    }
    startAt += page.length;
    const total = typeof body.total === "number" ? body.total : boards.length;
    if (page.length === 0 || startAt >= total) {
      break;
    }
  }

  return boards.sort((left, right) => left.name.localeCompare(right.name));
}

async function resolveBoard(
  credentials: JiraCredentials,
  input: { boardId?: string; projectKey?: string },
): Promise<{ boardId: string | null; name: string; projectKey: string }> {
  if (input.boardId) {
    const body = await jiraGet(credentials, `/rest/agile/1.0/board/${input.boardId}`);
    const board = normalizeBoard(body);
    if (board?.projectKey) {
      return { boardId: board.id, name: board.name, projectKey: board.projectKey };
    }
    if (board) {
      return {
        boardId: board.id,
        name: board.name,
        projectKey: input.projectKey?.toUpperCase() ?? DEFAULT_PROJECT,
      };
    }
  }

  const projectKey = (input.projectKey ?? DEFAULT_PROJECT).toUpperCase();
  const boards = await fetchBoards(credentials);
  const match =
    boards.find((board) => board.projectKey === projectKey) ??
    boards.find((board) => board.name.toLowerCase().includes(projectKey.toLowerCase()));
  return {
    boardId: match?.id ?? null,
    name: match?.name ?? (projectKey === DEFAULT_PROJECT ? DEFAULT_BOARD_NAME : projectKey),
    projectKey,
  };
}

function normalizeBoard(raw: unknown): JiraBoardOption | null {
  const board = asRecord(raw);
  const id = board?.id;
  const name = asString(board?.name);
  if (!board || !name || (typeof id !== "number" && typeof id !== "string")) {
    return null;
  }
  const location = asRecord(board.location);
  return {
    id: String(id),
    name,
    type: asString(board.type) ?? "simple",
    projectKey: asString(location?.projectKey),
  };
}

async function jiraGet(
  credentials: JiraCredentials,
  pathname: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(pathname, credentials.url), {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: basicAuth(credentials),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Jira request failed (${response.status})`);
  }
  const body: unknown = await response.json();
  return asRecord(body) ?? {};
}

async function jiraRequest(
  credentials: JiraCredentials,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const endpoints = ["/rest/api/3/search/jql", "/rest/api/3/search"];
  let lastError: Error | null = null;

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(new URL(endpoint, credentials.url), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: basicAuth(credentials),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 404 || response.status === 410) {
        lastError = new Error("Jira search endpoint unavailable");
        continue;
      }
      if (!response.ok) {
        throw new Error(`Jira search failed (${response.status})`);
      }
      const body: unknown = await response.json();
      return asRecord(body) ?? {};
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Jira request failed");
    }
  }

  throw lastError ?? new Error("Unable to read Jira board");
}

function normalizeIssue(raw: unknown, siteUrl: string): JiraIssue | null {
  const issue = asRecord(raw) as RawIssue | null;
  const key = asString(issue?.key);
  const id = asString(issue?.id);
  const fields = asRecord(issue?.fields);
  if (!issue || !key || !id || !fields) {
    return null;
  }

  const status = asRecord(fields.status);
  const statusCategory = asRecord(status?.statusCategory);
  const issueType = asRecord(fields.issuetype);
  const assignee = asRecord(fields.assignee);
  const parent = asRecord(fields.parent);
  const parentFields = asRecord(parent?.fields);
  const labels = Array.isArray(fields.labels)
    ? fields.labels.filter((label): label is string => typeof label === "string")
    : [];

  return {
    id,
    key,
    summary: asString(fields.summary) ?? key,
    status: asString(status?.name) ?? "Unknown",
    statusCategory: asString(statusCategory?.key) ?? asString(statusCategory?.name) ?? "new",
    issueType: asString(issueType?.name) ?? "Task",
    assignee: asString(assignee?.displayName) ?? "Unassigned",
    parentKey: asString(parent?.key),
    parentSummary: asString(parentFields?.summary),
    url: `${trimSlash(siteUrl)}/browse/${key}`,
    updated: asString(fields.updated),
    labels,
  };
}

async function resolveCredentials(): Promise<JiraCredentials> {
  const fromEnv = credentialsFromRecord({
    JIRA_URL: process.env.JIRA_URL,
    JIRA_USERNAME: process.env.JIRA_USERNAME,
    JIRA_API_TOKEN: process.env.JIRA_API_TOKEN,
  });
  if (fromEnv) {
    return fromEnv;
  }

  const fromMcp = credentialsFromRecord(await readAtlassianMcpEnv());
  if (fromMcp) {
    return fromMcp;
  }

  throw new Error(
    "Jira credentials were not found. Keep an Atlassian MCP server (mcp-atlassian) in Cursor, Claude, or Kiro, or set JIRA_URL, JIRA_USERNAME, and JIRA_API_TOKEN on the daemon.",
  );
}

function credentialsFromRecord(
  record: Record<string, string | undefined>,
): JiraCredentials | null {
  const url = asString(record.JIRA_URL);
  const username = asString(record.JIRA_USERNAME);
  const token = asString(record.JIRA_API_TOKEN);
  if (!url || !username || !token) {
    return null;
  }
  return { url: trimSlash(url), username, token };
}

function basicAuth(credentials: JiraCredentials) {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.token}`).toString("base64")}`;
}

function publicError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unable to read Jira board";
  return message.replace(/Basic\s+\S+/gi, "Basic [redacted]");
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
