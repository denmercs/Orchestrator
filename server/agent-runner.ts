import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  profilesFromConfigGet,
  resolveRunnerConfig,
  type AgentCreateConfig,
} from "../shared/agent-runner";

type PaseoApi = PluginHandlerContext["paseo"];

export async function loadRunnerConfig(paseo: PaseoApi, profileId: string): Promise<AgentCreateConfig> {
  try {
    const got = await paseo.config.get();
    return resolveRunnerConfig(profilesFromConfigGet(got), profileId).config;
  } catch (error) {
    console.warn("orchestrator: unable to read agent profiles", error);
    return resolveRunnerConfig([], profileId).config;
  }
}
