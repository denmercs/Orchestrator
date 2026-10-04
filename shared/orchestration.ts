import { defineRpc } from "@getpaseo/plugin";
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
