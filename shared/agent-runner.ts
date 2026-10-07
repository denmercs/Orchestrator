import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export {
  FALLBACK_AGENT_CONFIG,
  materializeProfile,
  pickProfile,
  profileCaption,
  profilesFromConfigGet,
  resolveRunnerConfig,
  type AgentCreateConfig,
  type AgentProfile,
} from "./agent-profiles";

// Which Paseo agent profile new orchestrator sessions use. Flip this when Claude is
// out of quota (Kiro) or when a personal repo should run on Cursor. Already-running
// agents keep the provider they started with.

export const agentRunnerSettings = defineSettings({
  id: "agent-runner",
  scope: "host",
  version: 1,
  schema: z.object({
    profileId: z.string().default(""),
  }),
});

