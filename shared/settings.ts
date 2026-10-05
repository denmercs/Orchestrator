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
  version: 2,
  schema: z.object({
    defaultBoardId: z.string().default(""),
    // Board picker name filter; empty lists every board.
    boardFilter: z.string().default("DCE"),
    // Assignee the Jira board opens filtered to; empty means everyone.
    developer: z.string().default(""),
  }),
  migrate(values) {
    const row = values !== null && typeof values === "object" ? (values as Record<string, unknown>) : {};
    return {
      defaultBoardId: typeof row.defaultBoardId === "string" ? row.defaultBoardId : "",
      boardFilter: typeof row.boardFilter === "string" ? row.boardFilter : "DCE",
      developer: typeof row.developer === "string" ? row.developer : "",
    };
  },
});

export const prodPulseSettings = defineSettings({
  id: "prod-pulse",
  scope: "host",
  version: 1,
  schema: z.object({
    autoSchedule: z.boolean().default(false),
  }),
});
