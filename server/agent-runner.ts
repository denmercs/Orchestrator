import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  materializeProfile,
  pickProfile,
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

// A pipeline phase's own profile, or `fallback` (the runner's config) when it names none or none is found.
export async function loadPhaseConfig(
  paseo: PaseoApi,
  profileId: string | undefined,
  fallback: AgentCreateConfig,
): Promise<AgentCreateConfig> {
  if (!profileId) return fallback;
  try {
    const profile = pickProfile(profilesFromConfigGet(await paseo.config.get()), profileId);
    if (profile) return materializeProfile(profile);
    console.warn("orchestrator: no agent profile named", profileId);
  } catch (error) {
    console.warn("orchestrator: unable to read agent profiles", error);
  }
  return fallback;
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
