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
  statusCategory: z.string(),
  issueType: z.string(),
  assignee: z.string(),
  parentKey: z.string().nullable(),
  parentSummary: z.string().nullable(),
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
    issues: z.array(jiraIssue),
    error: z.string().nullable(),
  }),
});

export type JiraIssue = z.infer<typeof jiraIssue>;
export type JiraBoardOption = z.infer<typeof jiraBoardOption>;

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
});

export const listOrchestrationStandupTodos = defineRpc({
  name: "orchestration.standup.todos.list",
  input: z.object({
    folderPath: z.string(),
  }),
  output: z.object({
    notePath: z.string(),
    exists: z.boolean(),
    items: z.array(standupTodo),
  }),
});

export const saveOrchestrationStandupTodos = defineRpc({
  name: "orchestration.standup.todos.save",
  input: z.object({
    folderPath: z.string(),
    templatePath: z.string().nullable(),
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
