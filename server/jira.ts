import type { RpcOutput } from "@getpaseo/plugin";
import {
  getJiraBoard,
  listJiraBoards,
  listJiraPullRequests,
  listOrchestrationStandupWork,
  moveJiraIssue,
  type JiraBoardColumn,
  type JiraBoardOption,
  type JiraIssue,
  type JiraPullRequest,
  type JiraSprint,
  type StandupWorkItem,
} from "../shared/orchestration";
import { readAtlassianMcpEnv } from "./host-mcp";

const DEFAULT_PROJECT = "QUICK";
const DEFAULT_BOARD_NAME = "QuickPress";
const ACTIVE_LIMIT = 50;
const DONE_LIMIT = 12;
const PARENT_LIMIT = 40;
const BOARD_ISSUE_LIMIT = 150;
const ISSUE_FIELDS = ["summary", "status", "issuetype", "assignee", "parent", "labels", "updated", "project"];

// Used when a board's column config can't be read (no board id, or no access).
const DEFAULT_COLUMNS: JiraBoardColumn[] = [
  ["Backlog", ["Backlog", "To Do", "Open"]],
  ["Selected for Development", ["Selected for Development"]],
  ["Ready for Development", ["Ready for Development"]],
  ["In Progress", ["In Progress"]],
  ["Reviewing", ["Ready for Review", "In Review", "Code Review"]],
  ["QA Ready", ["Ready for Testing", "QA Ready"]],
  ["Testing", ["In Testing", "Testing", "QA"]],
  ["Release Ready", ["Ready for Release", "Release Ready"]],
  ["Done", ["Done", "Closed", "Resolved"]],
].map(([name, statusNames]) => ({
  name: name as string,
  statusIds: [],
  statusNames: statusNames as string[],
}));

const WORK_LIMIT = 50;
// DCE is a family of Jira projects (DC, DCD, DAAFP, …) that share a "DCE:" name prefix.
const WORK_PROJECT_PREFIX = "DCE";
const WORK_STATUS_ORDER = ["indeterminate", "new", "done"];

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

export async function listAccessibleJiraBoards(
  nameFilter?: string,
): Promise<RpcOutput<typeof listJiraBoards>> {
  try {
    const credentials = await resolveCredentials();
    return { boards: await fetchBoards(credentials, nameFilter), error: null };
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
    if (selected.boardId) {
      const [columns, sprintBoard] = await Promise.all([
        fetchBoardColumns(credentials, selected.boardId),
        fetchSprintIssues(credentials, selected.boardId, selected.type),
      ]);
      return {
        ...selected,
        ...withoutBacklog(columns, sprintBoard.issues),
        sprint: sprintBoard.sprint,
        error: null,
      };
    }
    const issues = await fetchBoardIssues(credentials, selected.projectKey);
    return {
      ...selected,
      ...withoutBacklog(DEFAULT_COLUMNS, issues),
      sprint: null,
      error: null,
    };
  } catch (error) {
    const projectKey = (input.projectKey ?? DEFAULT_PROJECT).toUpperCase();
    return {
      boardId: input.boardId ?? null,
      name: projectKey === DEFAULT_PROJECT ? DEFAULT_BOARD_NAME : projectKey,
      projectKey,
      columns: withoutBacklog(DEFAULT_COLUMNS, []).columns,
      sprint: null,
      issues: [],
      error: publicError(error),
    };
  }
}

export async function moveIssueToColumn(
  input: { key: string; column: JiraBoardColumn },
): Promise<RpcOutput<typeof moveJiraIssue>> {
  try {
    const credentials = await resolveCredentials();
    const key = encodeURIComponent(input.key);
    const body = await jiraGet(credentials, `/rest/api/3/issue/${key}/transitions`);
    const ids = new Set(input.column.statusIds);
    const names = new Set(input.column.statusNames.map((name) => name.toLowerCase()));
    const transition = (Array.isArray(body.transitions) ? body.transitions : [])
      .map((raw) => asRecord(raw))
      .find((raw) => {
        const to = asRecord(raw?.to);
        const toId = to?.id;
        const toName = asString(to?.name)?.toLowerCase();
        return (
          ((typeof toId === "string" || typeof toId === "number") && ids.has(String(toId))) ||
          (toName != null && names.has(toName))
        );
      });
    const id = transition?.id;
    if (!transition || (typeof id !== "string" && typeof id !== "number")) {
      return {
        ok: false,
        status: null,
        error: `Jira has no transition from ${input.key}'s current status to ${input.column.name}.`,
      };
    }
    await jiraSend(credentials, `/rest/api/3/issue/${key}/transitions`, {
      transition: { id: String(id) },
    });
    return { ok: true, status: asString(asRecord(transition.to)?.name), error: null };
  } catch (error) {
    return { ok: false, status: null, error: publicError(error) };
  }
}

const PR_CACHE_MS = 60_000;
const PR_ISSUE_LIMIT = 60;
const PR_CONCURRENCY = 6;
const prCache = new Map<string, { at: number; prs: JiraPullRequest[] }>();

// Open PRs come from Jira's GitHub integration (the issue's "Development" panel).
export async function loadJiraPullRequests(input: {
  issues: { id: string; key: string }[];
}): Promise<RpcOutput<typeof listJiraPullRequests>> {
  try {
    const credentials = await resolveCredentials();
    const queue = input.issues.slice(0, PR_ISSUE_LIMIT);
    const prs: JiraPullRequest[] = [];
    let next = 0;
    async function worker() {
      while (next < queue.length) {
        const issue = queue[next++];
        if (issue) {
          prs.push(...(await issuePullRequests(credentials, issue)));
        }
      }
    }
    await Promise.all(Array.from({ length: PR_CONCURRENCY }, worker));
    return { prs, error: null };
  } catch (error) {
    return { prs: [], error: publicError(error) };
  }
}

async function issuePullRequests(
  credentials: JiraCredentials,
  issue: { id: string; key: string },
): Promise<JiraPullRequest[]> {
  const cached = prCache.get(issue.id);
  if (cached && Date.now() - cached.at < PR_CACHE_MS) {
    return cached.prs;
  }
  const summary = await jiraGet(
    credentials,
    `/rest/dev-status/latest/issue/summary?issueId=${encodeURIComponent(issue.id)}`,
  );
  const byInstance = asRecord(asRecord(asRecord(summary.summary)?.pullrequest)?.byInstanceType) ?? {};
  // The instance key (e.g. "oAuth-com.github.integration.production") is the applicationType.
  const instances = Object.entries(byInstance)
    .filter(([, value]) => Number(asRecord(value)?.count ?? 0) > 0)
    .map(([key]) => key);
  const prs: JiraPullRequest[] = [];
  for (const instance of instances) {
    const query = new URLSearchParams({
      issueId: issue.id,
      applicationType: instance,
      dataType: "pullrequest",
    });
    const body = await jiraGet(credentials, `/rest/dev-status/latest/issue/detail?${query}`);
    const details = Array.isArray(body.detail) ? body.detail : [];
    for (const detail of details) {
      const list = asRecord(detail)?.pullRequests;
      for (const raw of Array.isArray(list) ? list : []) {
        const pr = normalizePullRequest(raw, issue.key);
        if (pr && !prs.some((existing) => existing.url === pr.url)) {
          prs.push(pr);
        }
      }
    }
  }
  prCache.set(issue.id, { at: Date.now(), prs });
  return prs;
}

function normalizePullRequest(raw: unknown, issueKey: string): JiraPullRequest | null {
  const pr = asRecord(raw);
  const status = asString(pr?.status)?.toUpperCase();
  const url = asString(pr?.url);
  const title = asString(pr?.name) ?? "";
  const branch = asString(asRecord(pr?.source)?.branch);
  if (!pr || !url || (status !== "OPEN" && status !== "DRAFT")) {
    return null;
  }
  // Jira links PRs that merely mention a key; keep the ones actually built for this issue.
  const key = issueKey.toUpperCase();
  if (!title.toUpperCase().includes(key) && !branch?.toUpperCase().includes(key)) {
    return null;
  }
  return {
    issueKey,
    number: (asString(pr.id) ?? url.split("/").pop() ?? "").replace(/^#/, ""),
    title,
    url,
    status,
    branch,
    repo: asString(pr.repositoryName),
  };
}

async function fetchBoardColumns(
  credentials: JiraCredentials,
  boardId: string,
): Promise<JiraBoardColumn[]> {
  try {
    const body = await jiraGet(credentials, `/rest/agile/1.0/board/${boardId}/configuration`);
    const raw = asRecord(body.columnConfig)?.columns;
    const columns = (Array.isArray(raw) ? raw : []).flatMap((entry): JiraBoardColumn[] => {
      const column = asRecord(entry);
      const name = asString(column?.name);
      const statuses = Array.isArray(column?.statuses) ? column.statuses : [];
      const statusIds = statuses.flatMap((status) => {
        const id = asRecord(status)?.id;
        return typeof id === "string" || typeof id === "number" ? [String(id)] : [];
      });
      // Kanban boards include an empty "Backlog" placeholder column; skip status-less columns.
      if (!name || statusIds.length === 0) {
        return [];
      }
      return [{ name: titleCase(name), statusIds, statusNames: [] }];
    });
    return columns.length > 0 ? columns : DEFAULT_COLUMNS;
  } catch {
    return DEFAULT_COLUMNS;
  }
}

// Mirrors Jira's "Active sprints" view. Kanban boards have no sprints of their own, but their
// issues often sit in another board's sprint, so try that first and fall back to recent work.
async function fetchSprintIssues(
  credentials: JiraCredentials,
  boardId: string,
  boardType: string,
): Promise<{ sprint: JiraSprint | null; issues: JiraIssue[] }> {
  const boardSprint = boardType === "scrum" ? await fetchActiveSprint(credentials, boardId) : null;
  const inSprint = await fetchBoardPage(
    credentials,
    boardId,
    "sprint in openSprints() ORDER BY Rank ASC",
  );
  if (inSprint.issues.length > 0 || boardSprint) {
    return { sprint: boardSprint ?? inSprint.sprint, issues: inSprint.issues };
  }
  const recent = await fetchBoardPage(
    credentials,
    boardId,
    "statusCategory != Done OR updated >= -14d ORDER BY updated DESC",
  );
  return { sprint: null, issues: recent.issues };
}

async function fetchBoardPage(
  credentials: JiraCredentials,
  boardId: string,
  jql: string,
): Promise<{ sprint: JiraSprint | null; issues: JiraIssue[] }> {
  const issues: JiraIssue[] = [];
  let sprint: JiraSprint | null = null;
  let startAt = 0;
  while (issues.length < BOARD_ISSUE_LIMIT) {
    const query = new URLSearchParams({
      jql,
      startAt: String(startAt),
      maxResults: "50",
      fields: [...ISSUE_FIELDS, "sprint"].join(","),
    });
    const body = await jiraGet(credentials, `/rest/agile/1.0/board/${boardId}/issue?${query}`);
    const page = Array.isArray(body.issues) ? body.issues : [];
    for (const raw of page) {
      sprint ??= activeSprintOf(raw);
      const issue = normalizeIssue(raw, credentials.url);
      if (issue) {
        issues.push(issue);
      }
    }
    startAt += page.length;
    const total = typeof body.total === "number" ? body.total : issues.length;
    if (page.length === 0 || startAt >= total) {
      break;
    }
  }
  return { sprint, issues };
}

function activeSprintOf(raw: unknown): JiraSprint | null {
  const sprint = asRecord(asRecord(asRecord(raw)?.fields)?.sprint);
  const name = asString(sprint?.name);
  return name && asString(sprint?.state) === "active"
    ? { name, goal: asString(sprint?.goal), endDate: asString(sprint?.endDate) }
    : null;
}

// The board starts at "Selected for Development"; backlog work stays in Jira's backlog view.
function withoutBacklog(columns: JiraBoardColumn[], issues: JiraIssue[]) {
  const backlog = columns.filter((column) => /^backlog$/i.test(column.name.trim()));
  if (backlog.length === 0) {
    return { columns, issues };
  }
  const statusIds = new Set(backlog.flatMap((column) => column.statusIds));
  const statusNames = new Set(
    backlog.flatMap((column) => column.statusNames.map((name) => name.toLowerCase())),
  );
  return {
    columns: columns.filter((column) => !backlog.includes(column)),
    issues: issues.filter(
      (issue) =>
        !(issue.statusId != null && statusIds.has(issue.statusId)) &&
        !statusNames.has(issue.status.toLowerCase()),
    ),
  };
}

async function fetchActiveSprint(
  credentials: JiraCredentials,
  boardId: string,
): Promise<JiraSprint | null> {
  try {
    const body = await jiraGet(credentials, `/rest/agile/1.0/board/${boardId}/sprint?state=active`);
    const first = asRecord(Array.isArray(body.values) ? body.values[0] : null);
    const name = asString(first?.name);
    return name
      ? { name, goal: asString(first?.goal), endDate: asString(first?.endDate) }
      : null;
  } catch {
    return null;
  }
}

function titleCase(value: string) {
  return value === value.toUpperCase()
    ? value
        .toLowerCase()
        .replace(/\b(\w)(\w*)/g, (word, first: string, rest: string) =>
          // Keep short acronyms like "QA" upper case.
          word.length <= 2 ? word.toUpperCase() : first.toUpperCase() + rest,
        )
    : value;
}

export async function listMyWorkStories(): Promise<RpcOutput<typeof listOrchestrationStandupWork>> {
  try {
    const credentials = await resolveCredentials();
    const issues = await searchIssues(
      credentials,
      "assignee = currentUser() AND issuetype not in subTaskIssueTypes() AND (statusCategory != Done OR resolved >= startOfDay()) ORDER BY updated DESC",
      WORK_LIMIT,
    );
    const items = issues
      .filter((issue) => issue.projectName?.toUpperCase().startsWith(WORK_PROJECT_PREFIX))
      .map(toWorkItem)
      .sort((left, right) => workRank(left) - workRank(right));
    return { items, error: null };
  } catch (error) {
    return { items: [], error: publicError(error) };
  }
}

function toWorkItem(issue: SearchedIssue): StandupWorkItem {
  return {
    key: issue.key,
    summary: issue.summary,
    status: issue.status,
    statusCategory: issue.statusCategory,
    issueType: issue.issueType,
    projectKey: issue.projectKey ?? issue.key.split("-")[0],
    url: issue.url,
  };
}

function workRank(item: StandupWorkItem) {
  const rank = WORK_STATUS_ORDER.indexOf(item.statusCategory);
  return rank < 0 ? WORK_STATUS_ORDER.length : rank;
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

// Status, title and link for each key. Fetched one by one so a key Jira doesn't know (deleted,
// typo, no access) is just left out instead of failing the rest.
export async function readIssueStatuses(keys: string[]) {
  const wanted = [...new Set(keys.filter((key) => /^[A-Z][A-Z0-9_]+-\d+$/.test(key)))];
  const found = new Map<string, SearchedIssue>();
  if (wanted.length === 0) return found;
  const credentials = await resolveCredentials();
  const results = await Promise.allSettled(
    wanted.map((key) => jiraGet(credentials, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS.join(",")}`)),
  );
  for (const result of results) {
    const issue = result.status === "fulfilled" ? normalizeIssue(result.value, credentials.url) : null;
    if (issue) found.set(issue.key, issue);
  }
  return found;
}

async function searchIssues(
  credentials: JiraCredentials,
  jql: string,
  limit: number,
): Promise<SearchedIssue[]> {
  const issues: SearchedIssue[] = [];
  let nextPageToken: string | undefined;
  let startAt = 0;

  while (issues.length < limit) {
    const remaining = limit - issues.length;
    const payload: Record<string, unknown> = {
      jql,
      maxResults: Math.min(50, remaining),
      fields: ISSUE_FIELDS,
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

async function fetchBoards(
  credentials: JiraCredentials,
  nameFilter?: string,
): Promise<JiraBoardOption[]> {
  const boards: JiraBoardOption[] = [];
  const name = nameFilter?.trim();
  const nameParam = name ? `&name=${encodeURIComponent(name)}` : "";
  let startAt = 0;

  while (boards.length < 200) {
    const body = await jiraGet(
      credentials,
      `/rest/agile/1.0/board?startAt=${startAt}&maxResults=50${nameParam}`,
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
): Promise<{ boardId: string | null; name: string; projectKey: string; type: string }> {
  if (input.boardId) {
    const body = await jiraGet(credentials, `/rest/agile/1.0/board/${input.boardId}`);
    const board = normalizeBoard(body);
    if (board?.projectKey) {
      return { boardId: board.id, name: board.name, projectKey: board.projectKey, type: board.type };
    }
    if (board) {
      return {
        boardId: board.id,
        name: board.name,
        projectKey: input.projectKey?.toUpperCase() ?? DEFAULT_PROJECT,
        type: board.type,
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
    type: match?.type ?? "simple",
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

async function jiraSend(
  credentials: JiraCredentials,
  pathname: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(new URL(pathname, credentials.url), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: basicAuth(credentials),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Jira update failed (${response.status})`);
  }
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

type SearchedIssue = JiraIssue & {
  projectKey: string | null;
  projectName: string | null;
};

function normalizeIssue(raw: unknown, siteUrl: string): SearchedIssue | null {
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
  const project = asRecord(fields.project);
  const labels = Array.isArray(fields.labels)
    ? fields.labels.filter((label): label is string => typeof label === "string")
    : [];

  return {
    id,
    key,
    summary: asString(fields.summary) ?? key,
    status: asString(status?.name) ?? "Unknown",
    statusId: asString(status?.id),
    statusCategory: asString(statusCategory?.key) ?? asString(statusCategory?.name) ?? "new",
    issueType: asString(issueType?.name) ?? "Task",
    assignee: asString(assignee?.displayName) ?? "Unassigned",
    parentKey: asString(parent?.key),
    parentSummary: asString(parentFields?.summary),
    parentIssueType: asString(asRecord(parentFields?.issuetype)?.name),
    url: `${trimSlash(siteUrl)}/browse/${key}`,
    updated: asString(fields.updated),
    labels,
    projectKey: asString(project?.key),
    projectName: asString(project?.name),
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
