import { defineRpc, type RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";

export const orchestrationSchedule = z.object({
  id: z.string(),
  name: z.string().nullable(),
  status: z.enum(["active", "paused", "completed"]),
  cadence: z.string(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
});

export const listOrchestrationSchedules = defineRpc({
  name: "orchestration.schedules",
  input: z.object({}),
  output: z.object({
    schedules: z.array(orchestrationSchedule),
  }),
});

export const orchestrationParentLink = z.object({
  agentId: z.string(),
  parentAgentId: z.string().nullable(),
});

export const listOrchestrationParents = defineRpc({
  name: "orchestration.parents",
  input: z.object({
    agentIds: z.array(z.string()),
  }),
  output: z.object({
    links: z.array(orchestrationParentLink),
  }),
});

export const jiraIssue = z.object({
  id: z.string(),
  key: z.string(),
  summary: z.string(),
  status: z.string(),
  statusId: z.string().nullable(),
  statusCategory: z.string(),
  issueType: z.string(),
  assignee: z.string(),
  parentKey: z.string().nullable(),
  parentSummary: z.string().nullable(),
  // "Epic" for stories under an epic; a story's type for sub-tasks.
  parentIssueType: z.string().nullable(),
  url: z.string(),
  updated: z.string().nullable(),
  labels: z.array(z.string()),
});

export const jiraBoardOption = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  projectKey: z.string().nullable(),
});

export const listJiraBoards = defineRpc({
  name: "orchestration.jira-boards",
  input: z.object({}),
  output: z.object({
    boards: z.array(jiraBoardOption),
    error: z.string().nullable(),
  }),
});

export const jiraBoardColumn = z.object({
  name: z.string(),
  statusIds: z.array(z.string()),
  statusNames: z.array(z.string()),
});

export const jiraSprint = z.object({
  name: z.string(),
  goal: z.string().nullable(),
  endDate: z.string().nullable(),
});

// Moves an issue into a board column by running the Jira transition that lands on one of the
// column's statuses.
export const moveJiraIssue = defineRpc({
  name: "orchestration.jira-move",
  input: z.object({
    key: z.string(),
    column: jiraBoardColumn,
  }),
  output: z.object({
    ok: z.boolean(),
    status: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const getJiraBoard = defineRpc({
  name: "orchestration.jira-board",
  input: z.object({
    boardId: z.string().optional(),
    projectKey: z.string().optional(),
  }),
  output: z.object({
    boardId: z.string().nullable(),
    name: z.string(),
    projectKey: z.string(),
    columns: z.array(jiraBoardColumn),
    sprint: jiraSprint.nullable(),
    issues: z.array(jiraIssue),
    error: z.string().nullable(),
  }),
});

export const jiraPullRequest = z.object({
  issueKey: z.string(),
  number: z.string(),
  title: z.string(),
  url: z.string(),
  status: z.enum(["OPEN", "DRAFT"]),
  branch: z.string().nullable(),
  repo: z.string().nullable(),
});

export const listJiraPullRequests = defineRpc({
  name: "orchestration.jira-prs",
  input: z.object({
    issues: z.array(z.object({ id: z.string(), key: z.string() })),
  }),
  output: z.object({
    prs: z.array(jiraPullRequest),
    error: z.string().nullable(),
  }),
});

export type JiraIssue = z.infer<typeof jiraIssue>;
export type JiraPullRequest = z.infer<typeof jiraPullRequest>;
export type JiraBoardOption = z.infer<typeof jiraBoardOption>;
export type JiraBoardColumn = z.infer<typeof jiraBoardColumn>;
export type JiraSprint = z.infer<typeof jiraSprint>;

export const orchestrationFolderEntry = z.object({
  name: z.string(),
  path: z.string(),
});

export const listOrchestrationFolders = defineRpc({
  name: "orchestration.folders",
  input: z.object({
    path: z.string().nullable(),
  }),
  output: z.object({
    path: z.string(),
    parent: z.string().nullable(),
    entries: z.array(orchestrationFolderEntry),
  }),
});

export const orchestrationMergedPr = z.object({
  number: z.string(),
  title: z.string(),
  key: z.string(),
  url: z.string(),
  repo: z.string(),
  mergedAt: z.string(),
});

export const standupWorkItem = z.object({
  key: z.string(),
  summary: z.string(),
  status: z.string(),
  statusCategory: z.string(),
  issueType: z.string(),
  projectKey: z.string(),
  url: z.string(),
});

export const listOrchestrationStandupWork = defineRpc({
  name: "orchestration.standup.work",
  input: z.object({}),
  output: z.object({
    items: z.array(standupWorkItem),
    error: z.string().nullable(),
  }),
});

export type StandupWorkItem = z.infer<typeof standupWorkItem>;

export const upsertOrchestrationStandupNote = defineRpc({
  name: "orchestration.standup.upsert",
  input: z.object({
    folderPath: z.string(),
    templatePath: z.string().nullable(),
  }),
  output: z.object({
    notePath: z.string(),
    created: z.boolean(),
    changed: z.boolean(),
    templateName: z.string().nullable(),
    prs: z.array(orchestrationMergedPr),
    work: z.array(standupWorkItem),
    workError: z.string().nullable(),
  }),
});

export const standupTodoKind = z.enum(["todo", "blocker", "note"]);

export const standupTodo = z.object({
  id: z.string(),
  kind: standupTodoKind,
  text: z.string(),
  done: z.boolean(),
  /** YYYY-MM-DD of the daily note the item lives in. */
  date: z.string(),
});

const standupDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const listOrchestrationStandupTodos = defineRpc({
  name: "orchestration.standup.todos.list",
  input: z.object({
    folderPath: z.string(),
  }),
  output: z.object({
    notePath: z.string(),
    exists: z.boolean(),
    today: z.string(),
    items: z.array(standupTodo),
  }),
});

export const saveOrchestrationStandupTodos = defineRpc({
  name: "orchestration.standup.todos.save",
  input: z.object({
    folderPath: z.string(),
    templatePath: z.string().nullable(),
    /** Daily note to write; null means today's note. */
    date: standupDate.nullable(),
    items: z.array(
      z.object({
        kind: standupTodoKind,
        text: z.string().min(1),
        done: z.boolean(),
      }),
    ),
  }),
  output: z.object({
    notePath: z.string(),
    created: z.boolean(),
    today: z.string(),
    items: z.array(standupTodo),
  }),
});

export type StandupTodo = z.infer<typeof standupTodo>;
export type StandupTodoKind = z.infer<typeof standupTodoKind>;

export const orchestrationTemplate = z.object({
  name: z.string(),
  path: z.string(),
});

export const listOrchestrationTemplates = defineRpc({
  name: "orchestration.obsidian.templates",
  input: z.object({
    folderPath: z.string().nullable(),
  }),
  output: z.object({
    templates: z.array(orchestrationTemplate),
    suggestedPath: z.string().nullable(),
  }),
});

export const listOrchestrationMergedPrs = defineRpc({
  name: "orchestration.standup.merged",
  input: z.object({}),
  output: z.object({
    date: z.string(),
    prs: z.array(orchestrationMergedPr),
    error: z.string().nullable(),
  }),
});

export const detectOrchestrationObsidian = defineRpc({
  name: "orchestration.obsidian.detect",
  input: z.object({}),
  output: z.object({
    vaultPath: z.string().nullable(),
    standupFolder: z.string().nullable(),
    label: z.string().nullable(),
  }),
});

export const prodPulseHealthKey = z.enum(["healthy", "watch", "unhealthy", "early", "unverified", "none"]);

export const prodPulseCard = z.object({
  key: z.string(),
  product: z.string(),
  label: z.string(),
  version: z.string(),
  publishedAt: z.string().nullable(),
  healthKey: prodPulseHealthKey,
  healthLabel: z.string(),
  healthWhy: z.string(),
  crashFreeSessions: z.number().nullable(),
  crashFreeUsers: z.number().nullable(),
  sessions: z.number().nullable(),
  users: z.number().nullable(),
  newBugs: z.number(),
  caveat: z.string().nullable(),
  url: z.string().nullable(),
});

export const prodPulseOrigin = z.enum(["regression", "new", "unchecked", "seen-before"]);

export const prodPulseIssue = z.object({
  id: z.string(),
  origin: prodPulseOrigin,
  product: z.string(),
  hit: z.string(),
  rawTitle: z.string().nullable(),
  trend: z.enum(["new", "rising", "flat"]),
  top: z.boolean(),
  users: z.string(),
  events: z.string(),
  firstSeen: z.string().nullable(),
  release: z.string().nullable(),
  shortId: z.string().nullable(),
  sentryUrl: z.string().nullable(),
  watchUrl: z.string().nullable(),
  watchLabel: z.string(),
  repro: z.array(z.string()),
  reproMissing: z.string().nullable(),
  findings: z.array(z.string()),
  likely: z.string().nullable(),
  groupedCount: z.number(),
});

export const prodPulseOlder = z.object({
  id: z.string(),
  product: z.string(),
  title: z.string(),
  users: z.number(),
  events: z.number(),
  status: z.string(),
  sentryUrl: z.string().nullable(),
});

export const getProdPulse = defineRpc({
  name: "orchestration.prod-pulse",
  input: z.object({}),
  output: z.object({
    available: z.boolean(),
    error: z.string().nullable(),
    dashboardUrl: z.string().nullable(),
    outcome: z.enum(["changed", "health", "no-change", "failed", "none"]),
    checkedAt: z.string().nullable(),
    changedAt: z.string().nullable(),
    failReason: z.string().nullable(),
    stale: z.boolean(),
    systemNotes: z.array(z.string()),
    cards: z.array(prodPulseCard),
    issues: z.array(prodPulseIssue),
    older: z.array(prodPulseOlder),
    actions: z.array(z.string()),
  }),
});

export type ProdPulse = RpcOutput<typeof getProdPulse>;
export type ProdPulseCard = z.infer<typeof prodPulseCard>;
export type ProdPulseIssue = z.infer<typeof prodPulseIssue>;
export type ProdPulseOlder = z.infer<typeof prodPulseOlder>;

export const prodPulseScheduleStatus = z.object({
  name: z.string(),
  label: z.string(),
  cadence: z.string(),
  status: z.enum(["active", "paused", "completed", "missing"]),
  nextRunAt: z.string().nullable(),
});

export const getProdPulseAutomation = defineRpc({
  name: "orchestration.prod-pulse.automation",
  input: z.object({}),
  output: z.object({
    jobInstalled: z.boolean(),
    jobPath: z.string(),
    schedules: z.array(prodPulseScheduleStatus),
    error: z.string().nullable(),
  }),
});

export type ProdPulseAutomation = RpcOutput<typeof getProdPulseAutomation>;

export const epicStory = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  dependsOn: z.array(z.string()),
  blockedBy: z.string(),
  blockedReason: z.string(),
  // Set when an agent filed this story while working on another.
  discoveredFrom: z.string(),
  pr: z.number().nullable(),
  // todo, every dependency merged, and not blocked.
  ready: z.boolean(),
});

// A phase is stored by number (phases/<n>-<name>); people read it as "Phase <n>".
export const phaseLabel = (id: string) => (/^\d+$/.test(id) ? `Phase ${id}` : id);

export const epicBoardState = z.object({
  epic: z.object({ id: z.string(), title: z.string(), dir: z.string() }),
  // Title of the initiative the epic (phase) belongs to.
  initiative: z.string(),
  // The phase's architecture plan, once architecture.md exists; warnings are gaps a person would notice.
  plan: z.object({ warnings: z.array(z.string()) }).nullable(),
  next: z.object({ story: z.string().nullable(), reason: z.string() }),
  repoUrl: z.string(),
  stories: z.array(epicStory),
});

export const getEpicBoard = defineRpc({
  name: "orchestration.epic-board",
  input: z.object({}),
  output: z.object({
    repo: z.string(),
    state: epicBoardState.nullable(),
    error: z.string().nullable(),
  }),
});

// Removes the initiative holding the active phase.
export const deleteEpicInitiative = defineRpc({
  name: "orchestration.epic-delete-initiative",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), error: z.string().nullable(), deleted: z.string().nullable() }),
});

// Every initiative in each repo's .harness/initiatives, in the layout the plugin creates
// (server/harness-layout.ts).
const harnessRepo = z.object({
  repo: z.string(),
  name: z.string(),
  initiatives: z.array(
    z.object({
      slug: z.string(),
      title: z.string(),
      epics: z.array(
        z.object({ id: z.string(), title: z.string(), path: z.string(), stories: z.number(), merged: z.number() }),
      ),
    }),
  ),
});

export const listHarnessInitiatives = defineRpc({
  name: "orchestration.harness-initiatives",
  input: z.object({ repos: z.array(z.string()) }),
  output: z.object({ repos: z.array(harnessRepo) }),
});

// Creates the initiative when `initiative` is empty (from initiativeTitle), then its next epic,
// then starts that phase's architecture session. `warning` says why the session didn't start.
export const createHarnessEpicRpc = defineRpc({
  name: "orchestration.harness-create-epic",
  input: z.object({
    repo: z.string(),
    initiative: z.string(),
    initiativeTitle: z.string(),
    epicTitle: z.string(),
  }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    epic: z.string().nullable(),
    agentId: z.string().nullable(),
    warning: z.string().nullable(),
  }),
});

// Starts the architecture session for an existing phase (repo-relative epic folder).
export const planHarnessPhaseRpc = defineRpc({
  name: "orchestration.harness-plan-phase",
  input: z.object({ repo: z.string(), epic: z.string() }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable(), agentId: z.string().nullable() }),
});

const phaseRef = z.object({ repo: z.string(), epic: z.string() });

// Renders the phase's architecture.html and returns a loopback http URL serving it (Paseo's
// in-app browser only opens http). The page reloads itself when architecture.md changes.
export const openPhasePlanRpc = defineRpc({
  name: "orchestration.harness-open-plan",
  input: phaseRef,
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    warnings: z.array(z.string()),
    url: z.string().nullable(),
  }),
});

// Jira → architecture.md, one way: sets each keyed card's status (and "Jira" table cells).
export const refreshPhasePlanRpc = defineRpc({
  name: "orchestration.harness-refresh-plan",
  input: phaseRef,
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    keys: z.number(),
    changed: z.number(),
    missing: z.array(z.string()),
  }),
});

export type HarnessRepo = z.infer<typeof harnessRepo>;
export type EpicStory = z.infer<typeof epicStory>;
export type EpicBoardState = NonNullable<RpcOutput<typeof getEpicBoard>["state"]>;

export const getDailyVerse = defineRpc({
  name: "orchestration.daily-verse",
  input: z.object({}),
  output: z.object({
    reference: z.string(),
    text: z.string().nullable(),
    translation: z.string(),
    // Copyright line the translation's terms require next to the text, if any.
    copyright: z.string().nullable(),
  }),
});

export type DailyVerse = RpcOutput<typeof getDailyVerse>;
