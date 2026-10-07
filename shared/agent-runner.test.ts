import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FALLBACK_AGENT_CONFIG,
  pickProfile,
  profileCaption,
  profilesFromConfigGet,
  resolveRunnerConfig,
  type AgentProfile,
} from "./agent-profiles";

const claude: AgentProfile = {
  id: "legacy_favorite:cursor:default",
  name: "default",
  provider: "claude",
  model: "claude-opus-5-5",
  modeId: "auto",
  thinkingOptionId: "medium",
};

const kiro: AgentProfile = {
  id: "agent_profile_kiro",
  name: "Kiro",
  provider: "kiro",
  model: "auto",
  modeId: "kiro_default",
  featureValues: { auto_accept: true },
};

test("empty profileId prefers the profile named default", () => {
  assert.equal(pickProfile([kiro, claude], ""), claude);
});

test("profileId matches id, then name", () => {
  assert.equal(pickProfile([claude, kiro], kiro.id), kiro);
  assert.equal(pickProfile([claude, kiro], "Kiro"), kiro);
});

test("unknown profileId does not silently stay on Claude", () => {
  const resolved = resolveRunnerConfig([claude, kiro], "missing");
  assert.equal(resolved.profile, null);
  assert.deepEqual(resolved.config, { ...FALLBACK_AGENT_CONFIG });
});

test("materialize joins provider/model and copies mode settings", () => {
  const { config } = resolveRunnerConfig([claude, kiro], kiro.id);
  assert.deepEqual(config, {
    provider: "kiro/auto",
    modeId: "kiro_default",
    featureValues: { auto_accept: true },
  });
});

test("profilesFromConfigGet reads daemon.agentProfiles", () => {
  const profiles = profilesFromConfigGet({
    config: { daemon: { agentProfiles: [claude, kiro] } },
  });
  assert.equal(profiles.length, 2);
  assert.equal(profileCaption(profiles[1]!), "Kiro · kiro/auto");
});
