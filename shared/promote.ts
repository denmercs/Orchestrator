import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Starts a Story-pipeline run for a chat-promoted scratch ticket. The server mints the key as
// `PROMOTE-<n>` for the workspace's repo and starts the initiative loop. No Jira is involved.
export const promoteSessionToStory = defineRpc({
  name: "orchestration.promote.session-to-story",
  input: z.object({
    workspaceId: z.string(),
    title: z.string(),
    kind: z.enum(["story", "bug"]),
  }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    ticketKey: z.string().nullable(),
    agentId: z.string().nullable(),
  }),
});
