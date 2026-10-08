import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  profileForStep,
  profilesFromConfigGet,
  resolveRunnerConfig,
  type AgentCreateConfig,
} from "../shared/agent-runner";
import type { LoopConfig, LoopStep } from "../shared/initiative-loop";

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

export async function loadStepConfig(
  paseo: PaseoApi,
  loop: Pick<LoopConfig, "profiles">,
  step: LoopStep,
  runnerProfileId: string,
): Promise<AgentCreateConfig> {
  try {
    const got = await paseo.config.get();
    return profileForStep(loop, step, profilesFromConfigGet(got), runnerProfileId).config;
  } catch (error) {
    console.warn("orchestrator: unable to read agent profiles", error);
    return profileForStep(loop, step, [], runnerProfileId).config;
  }
}
