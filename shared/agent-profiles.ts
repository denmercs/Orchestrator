export const FALLBACK_AGENT_CONFIG = {
  provider: "claude",
  modeId: "auto",
} as const;

export type AgentProfile = {
  id: string;
  name: string;
  provider: string;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  featureValues?: Record<string, unknown> | null;
};

export type AgentCreateConfig = {
  provider: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
};

export function materializeProfile(profile: AgentProfile): AgentCreateConfig {
  const config: AgentCreateConfig = {
    provider: profile.model ? `${profile.provider}/${profile.model}` : profile.provider,
  };
  if (profile.modeId) {
    config.modeId = profile.modeId;
  }
  if (profile.thinkingOptionId) {
    config.thinkingOptionId = profile.thinkingOptionId;
  }
  if (profile.featureValues) {
    config.featureValues = profile.featureValues;
  }
  return config;
}

export function pickProfile(profiles: AgentProfile[], profileId: string) {
  if (profileId) {
    return (
      profiles.find((profile) => profile.id === profileId) ??
      profiles.find((profile) => profile.name === profileId) ??
      null
    );
  }
  return profiles.find((profile) => profile.name === "default") ?? profiles[0] ?? null;
}

export function resolveRunnerConfig(
  profiles: AgentProfile[],
  profileId: string,
  fallback: AgentCreateConfig = FALLBACK_AGENT_CONFIG,
) {
  const profile = pickProfile(profiles, profileId);
  return {
    profile,
    config: profile ? materializeProfile(profile) : { ...fallback },
  };
}

export function profilesFromConfigGet(got: unknown): AgentProfile[] {
  const root = asRecord(got);
  const config = asRecord(root?.config) ?? root;
  const daemon = asRecord(config?.daemon) ?? config;
  const list = daemon?.agentProfiles ?? config?.agentProfiles;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.flatMap((item) => {
    const row = asRecord(item);
    if (!row || typeof row.id !== "string" || typeof row.provider !== "string") {
      return [];
    }
    return [
      {
        id: row.id,
        name: typeof row.name === "string" && row.name.trim() ? row.name : row.provider,
        provider: row.provider,
        model: typeof row.model === "string" ? row.model : null,
        modeId: typeof row.modeId === "string" ? row.modeId : null,
        thinkingOptionId: typeof row.thinkingOptionId === "string" ? row.thinkingOptionId : null,
        featureValues:
          row.featureValues && typeof row.featureValues === "object"
            ? (row.featureValues as Record<string, unknown>)
            : null,
      },
    ];
  });
}

export function profileCaption(profile: AgentProfile) {
  const model = profile.model ? `/${profile.model}` : "";
  return `${profile.name} · ${profile.provider}${model}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
