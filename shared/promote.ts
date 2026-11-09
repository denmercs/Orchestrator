import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Files a chat-promoted scratch ticket for the factory manager. The server mints the key as
// `PROMOTE-<n>` for the workspace's repo, creates its one-story initiative and files a slice in the
// harness repo's factory inbox. No agent is started and no Jira is involved, so `agentId` is always null.
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
