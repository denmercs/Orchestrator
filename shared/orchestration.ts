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

