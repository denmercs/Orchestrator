import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const standupSettings = defineSettings({
  id: "standup",
  scope: "host",
  version: 2,
  schema: z.object({
    standupFolder: z.string().default(""),
    templatePath: z.string().default(""),
  }),
  migrate(values) {
    const row = values !== null && typeof values === "object" ? (values as Record<string, unknown>) : {};
    return {
      standupFolder: typeof row.standupFolder === "string" ? row.standupFolder : "",
      templatePath: typeof row.templatePath === "string" ? row.templatePath : "",
    };
  },
});

export const jiraBoardSettings = defineSettings({
  id: "jira-board",
  scope: "host",
  version: 1,
  schema: z.object({
    defaultBoardId: z.string().default(""),
  }),
});

export const prodPulseSettings = defineSettings({
  id: "prod-pulse",
  scope: "host",
  version: 1,
  schema: z.object({
    autoSchedule: z.boolean().default(false),
  }),
});
