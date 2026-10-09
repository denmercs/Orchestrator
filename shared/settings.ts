import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { TAB_IDS } from "./dashboard-tabs";

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
  version: 3,
  schema: z.object({
    defaultBoardId: z.string().default(""),
    // Board picker name filter; empty lists every board (work and personal).
    boardFilter: z.string().default(""),
    // Assignee the Jira board opens filtered to; empty means everyone.
    developer: z.string().default(""),
    // Show the board's cards grouped under their Jira epic instead of in status columns.
    groupByEpic: z.boolean().default(false),
  }),
  migrate(values) {
    const row = values !== null && typeof values === "object" ? (values as Record<string, unknown>) : {};
    const rawFilter = typeof row.boardFilter === "string" ? row.boardFilter : "";
    return {
      defaultBoardId: typeof row.defaultBoardId === "string" ? row.defaultBoardId : "",
      // v2 defaulted this to "DCE", which hid boards outside work.
      boardFilter: rawFilter === "DCE" ? "" : rawFilter,
      developer: typeof row.developer === "string" ? row.developer : "",
      groupByEpic: row.groupByEpic === true,
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

export const harnessSettings = defineSettings({
  id: "harness",
  scope: "host",
  version: 1,
  schema: z.object({
    // Repo and repo-relative phase folder the initiative board shows; empty folds the board.
    repo: z.string().default(""),
    epic: z.string().default(""),
  }),
});

export const mcpSettings = defineSettings({
  id: "mcp",
  scope: "host",
  version: 1,
  schema: z.object({
    // Host MCP server names never copied onto agents; Jira credential lookup still reads them.
    mcpExclude: z.array(z.string()).default([]),
  }),
});

export const dashboardSettings = defineSettings({
  id: "dashboard",
  scope: "host",
  version: 1,
  schema: z.object({
    // Tab the dashboard opens on; an unknown stored tab falls back to initiatives.
    tab: z.enum(TAB_IDS).default("initiatives").catch("initiatives"),
  }),
});

export const budgetSettings = defineSettings({
  id: "budget",
  scope: "host",
  version: 1,
  schema: z.object({
    // Display only for now: the stats strip shows spend against these; nothing enforces them yet.
    dailyBudgetUsd: z.number().default(25),
    storyCapUsd: z.number().default(5),
  }),
});
