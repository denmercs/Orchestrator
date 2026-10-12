import { pickProfile, profileCaption, type AgentProfile } from "./agent-profiles";

// Env marker the voice entry points put on the sessions they create; the agent.create hook looks for it.
export const VOICE_SESSION_ENV = "ORCHESTRATOR_VOICE_SESSION";

// The profile a voice session runs on. Setting empty is Auto: the first Claude profile whose model or name says
// sonnet (same match the loop uses for its Sonnet steps). "off", an unknown name, or no profiles gives null.
export function voiceProfileFor(profiles: AgentProfile[], setting: string) {
  const value = setting.trim();
  if (value.toLowerCase() === "off") {
    return null;
  }
  if (value) {
    return pickProfile(profiles, value);
  }
  return (
    profiles.find(
      (profile) =>
        profile.provider === "claude" && `${profile.model ?? ""} ${profile.name}`.toLowerCase().includes("sonnet"),
    ) ?? null
  );
}

// The routing rule a voice session carries in its system prompt: the user is talking, not reading, so keep the
// work moving in the background and ask in numbered choices they can answer by number.
export const VOICE_ROUTING_RULE = [
  "Voice routing rule:",
  "- Code edits go through the loop: Plan → Implement → Review. Don't edit code directly in this session.",
  "- Small jobs (a lookup, a quick check, a rename) go to a background Sonnet or Haiku helper.",
  "- A hard call may go to at most one Opus helper. Never start more than one.",
  "- Every decision the user must make is offered as numbered choices they can answer by number.",
].join("\n");

// Sent once ahead of the first steer to a session that wasn't created as a voice session, which has no routing rule
// in its system prompt (its model can't change, so this is all it gets).
export const VOICE_ROUTING_PREAMBLE = `(Sent by voice. ${VOICE_ROUTING_RULE})`;

// The slice of a plugin agent.create request this module reads and writes (PluginBeforeRequests["agent.create"]).
export type VoiceRequest = {
  config: {
    provider: string;
    model?: string;
    modeId?: string;
    thinkingOptionId?: string;
    systemPrompt?: string;
  };
  env?: Record<string, string>;
};

// A request marked with VOICE_SESSION_ENV gets the voice profile (only when it names no model of its own) and the
// routing rule appended to its system prompt. Any other request comes back as the same object.
export function applyVoiceSession<T extends VoiceRequest>(request: T, profile: AgentProfile | null): T {
  if (request.env?.[VOICE_SESSION_ENV] !== "1") {
    return request;
  }
  const config = { ...request.config };
  if (profile && !config.model) {
    config.provider = profile.provider;
    if (profile.model) {
      config.model = profile.model;
    }
    if (profile.modeId) {
      config.modeId = profile.modeId;
    }
    if (profile.thinkingOptionId) {
      config.thinkingOptionId = profile.thinkingOptionId;
    }
  }
  config.systemPrompt = config.systemPrompt ? `${config.systemPrompt}\n\n${VOICE_ROUTING_RULE}` : VOICE_ROUTING_RULE;
  return { ...request, config };
}

// The drawer's one-line statement of what a new voice session will run on.
export function voiceModelLine(profile: AgentProfile | null, setting: string) {
  if (setting.trim().toLowerCase() === "off") {
    return "Voice sessions: default off";
  }
  return profile ? `Voice sessions run on ${profileCaption(profile)}` : "Voice sessions run on the Paseo default";
}
