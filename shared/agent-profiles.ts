import type { FactorySeat } from "./factory";
import type { LoopConfig, LoopStep } from "./initiative-loop";

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

// Decision d1: Plan and Review default to a deep profile, Implement and Fix CI to a fast one.
const STEP_TIER: Partial<Record<LoopStep, "deep" | "fast">> = {
  plan: "deep",
  diagnose: "deep",
  review: "deep",
  implement: "fast",
  fix: "fast",
};

export const PRODUCT_PLAN_MODEL = "claude-opus-5-5";
export const PRODUCT_REVIEW_MODEL = "grok-4.7";

// Prefer a Cursor agent profile for `model`, else a qualified cursor provider string.
export function cursorModelConfig(profiles: AgentProfile[], model: string): AgentCreateConfig {
  const profile = profiles.find((candidate) => candidate.provider === "cursor" && candidate.model === model);
  return profile ? materializeProfile(profile) : { provider: `cursor/${model}` };
}

// Plan, Diagnose and Review on product repos (not Orchestrator, not gihimo): Opus for planning, Grok for review.
export function productStepConfig(step: LoopStep, profiles: AgentProfile[]): AgentCreateConfig | null {
  // Den, 2026-11-15: Opus is strictly Plan; Grok reviews and diagnoses.
  if (step === "plan") return cursorModelConfig(profiles, PRODUCT_PLAN_MODEL);
  if (step === "review" || step === "diagnose") return cursorModelConfig(profiles, PRODUCT_REVIEW_MODEL);
  return null;
}

export function withProductPlanReviewStepConfig(
  productDefaults: boolean,
  step: LoopStep,
  profiles: AgentProfile[],
  config: AgentCreateConfig,
): AgentCreateConfig {
  if (!productDefaults) return config;
  return productStepConfig(step, profiles) ?? config;
}

// Cursor profiles other repos' factory seats default to: Composer for every role, Grok 4.7 for reviewer.
function repoSeatDefault(profiles: AgentProfile[], role: string) {
  const cursor = profiles.filter((candidate) => candidate.provider === "cursor");
  const model = role === "reviewer" ? PRODUCT_REVIEW_MODEL : "composer-2.5";
  return cursor.find((candidate) => candidate.model === model) ?? profileForTier(profiles, role === "reviewer" ? "deep" : "fast", "cursor");
}

// What marks a profile's tier in its name or model, first match wins. The role word works for any provider
// ("Grok deep", "grok-code-fast") and must stand alone, so "deepseek" is no tier; the Claude model names are the
// fallback for profiles named before roles existed.
const TIER_WORDS = { deep: [/\bdeep\b/, /opus/], fast: [/\bfast\b/, /sonnet/] } as const;

// The first profile of `provider` whose name or model carries the tier's word; null when none does.
export function profileForTier(profiles: AgentProfile[], tier: "deep" | "fast", provider: string) {
  const ofProvider = profiles.filter((candidate) => candidate.provider === provider);
  return (
    TIER_WORDS[tier]
      .map((word) => ofProvider.find((candidate) => word.test(`${candidate.model ?? ""} ${candidate.name}`.toLowerCase())))
      .find(Boolean) ?? null
  );
}

// Whether the daemon can start a Cursor agent. Cursor isn't built in, so Paseo answers "Provider cursor is not
// configured" to a `cursor/...` agent unless its providers list (`config.providers` in the daemon's config response,
// `agents.providers` in the file) has a `cursor` entry. A disabled entry always counts as missing. With no entry, a
// profile on Cursor counts as Cursor being there (a plugin can register it), and so does a config with no list at all.
// ponytail: config only — paseo.providers.listAvailable() would also see plugin-registered Cursor with no profile.
export function cursorConfigured(got: unknown, profiles: AgentProfile[]): boolean {
  const root = asRecord(got);
  const config = asRecord(root?.config) ?? root;
  const providers = asRecord(config?.providers) ?? asRecord(asRecord(config?.agents)?.providers);
  const cursor = asRecord(providers?.cursor);
  if (cursor) return cursor.enabled !== false;
  return !providers || profiles.some((profile) => profile.provider === "cursor");
}

// Claude's profile for a loop step when Cursor isn't there: deep (Opus) for Plan, Review and Diagnose, fast
// (Sonnet) for Implement and Fix CI. null for the PR step, or when no Claude profile carries the tier.
export function claudeStepConfig(step: LoopStep, profiles: AgentProfile[]): AgentCreateConfig | null {
  const tier = STEP_TIER[step];
  const profile = tier ? profileForTier(profiles, tier, "claude") : null;
  return profile ? materializeProfile(profile) : null;
}

// The loop step's default profile: the legacy `profiles` setting (id or name; nothing in the dashboard sets it
// now), else the d1 tier
// among profiles of the runner's provider, else the runner profile, else FALLBACK_AGENT_CONFIG.
export function profileForStep(
  loop: Pick<LoopConfig, "profiles">,
  step: LoopStep,
  profiles: AgentProfile[],
  runnerProfileId: string,
) {
  const runner = pickProfile(profiles, runnerProfileId);
  const tier = STEP_TIER[step];
  // Diagnose has no profile row of its own; it runs on Plan's.
  const setId = step === "pr" ? "" : loop.profiles[step === "diagnose" ? "plan" : step];
  const provider = runner?.provider ?? FALLBACK_AGENT_CONFIG.provider;
  const profile =
    (setId ? pickProfile(profiles, setId) : null) ?? (tier ? profileForTier(profiles, tier, provider) : null) ?? runner;
  return {
    profile,
    config: profile ? materializeProfile(profile) : { ...FALLBACK_AGENT_CONFIG },
  };
}

// A factory seat's profile: the one its file names (id or name), else its role's tier among the runner provider's
// profiles (the reviewer is deep, every other role fast). Null when neither resolves: there is no runner fallback, so
// the caller picks its own. Slices in another repo keep Claude out: a Claude profile in the seat file is ignored and
// tiers are chosen among Cursor profiles only.
export function seatProfile(
  seat: Pick<FactorySeat, "profile"> | undefined,
  role: string,
  profiles: AgentProfile[],
  runnerProfileId: string,
  orchestratorSlice = true,
  productPlanReviewDefaults = false,
) {
  if (productPlanReviewDefaults && role === "reviewer") return repoSeatDefault(profiles, role);
  const named = seat?.profile ? pickProfile(profiles, seat.profile) : null;
  if (named && (orchestratorSlice || named.provider !== "claude")) return named;
  if (!orchestratorSlice) return repoSeatDefault(profiles, role);
  const provider = pickProfile(profiles, runnerProfileId)?.provider ?? FALLBACK_AGENT_CONFIG.provider;
  return profileForTier(profiles, role === "reviewer" ? "deep" : "fast", provider);
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
