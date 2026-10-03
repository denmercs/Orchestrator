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
