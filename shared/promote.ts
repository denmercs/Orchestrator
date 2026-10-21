import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Starts a Story-pipeline run for a chat-promoted scratch ticket. The server mints the key as
// `PROMOTE-<n>` for the workspace's repo and starts the initiative loop. No Jira is involved.
// `carryContext` (default on) folds the originating chat into `.harness/context.md` so the planner
// reads it as background. `sourceAgentId` is the chat the user promoted from; null when the open
// surface has no agent (nothing to carry), in which case the server skips compaction.
export const promoteSessionToStory = defineRpc({
  name: "orchestration.promote.session-to-story",
  input: z.object({
    workspaceId: z.string(),
    title: z.string(),
    kind: z.enum(["story", "bug"]),
    carryContext: z.boolean().default(true),
    sourceAgentId: z.string().nullable(),
  }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    ticketKey: z.string().nullable(),
    agentId: z.string().nullable(),
  }),
});
