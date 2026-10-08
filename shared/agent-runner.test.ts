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
import { profileForStep } from "./agent-runner";
import { DEFAULT_LOOP_CONFIG, type LoopConfig } from "./initiative-loop";

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

const opus: AgentProfile = { id: "p_opus", name: "Deep", provider: "claude", model: "claude-opus-5-5" };
const sonnet: AgentProfile = { id: "p_sonnet", name: "Sonnet fast", provider: "claude", model: "claude-sonnet-5-5" };
const kiroOpus: AgentProfile = { id: "p_kiro_opus", name: "Kiro opus", provider: "kiro", model: "opus" };
const runner: AgentProfile = { id: "p_runner", name: "Runner", provider: "claude", model: "claude-haiku-4-5" };

const loopWith = (profiles: Partial<LoopConfig["profiles"]>): LoopConfig => ({
  ...DEFAULT_LOOP_CONFIG,
  profiles: { ...DEFAULT_LOOP_CONFIG.profiles, ...profiles },
});

test("profileForStep: a set id wins over the default tier", () => {
  const { profile, config } = profileForStep(loopWith({ plan: sonnet.id }), "plan", [opus, sonnet, runner], runner.id);
  assert.equal(profile, sonnet);
  assert.deepEqual(config, { provider: "claude/claude-sonnet-5-5" });
});

test("profileForStep: a set name wins too", () => {
  assert.equal(profileForStep(loopWith({ fix: "Deep" }), "fix", [opus, sonnet, runner], runner.id).profile, opus);
});

test("profileForStep: empty picks Opus for plan/review and Sonnet for implement/fix", () => {
  const all = [runner, sonnet, opus];
  assert.equal(profileForStep(DEFAULT_LOOP_CONFIG, "plan", all, runner.id).profile, opus);
  assert.equal(profileForStep(DEFAULT_LOOP_CONFIG, "review", all, runner.id).profile, opus);
  assert.equal(profileForStep(DEFAULT_LOOP_CONFIG, "implement", all, runner.id).profile, sonnet);
  assert.equal(profileForStep(DEFAULT_LOOP_CONFIG, "fix", all, runner.id).profile, sonnet);
});

test("profileForStep: an unknown id falls back like empty", () => {
  const all = [runner, sonnet, opus];
  assert.equal(profileForStep(loopWith({ review: "missing" }), "review", all, runner.id).profile, opus);
  assert.equal(profileForStep(loopWith({ implement: "missing" }), "implement", all, runner.id).profile, sonnet);
});

test("profileForStep: no profile of the tier means the runner profile", () => {
  assert.equal(profileForStep(DEFAULT_LOOP_CONFIG, "plan", [sonnet, runner], runner.id).profile, runner);
  assert.equal(profileForStep(DEFAULT_LOOP_CONFIG, "fix", [opus, runner], runner.id).profile, runner);
});

test("profileForStep: another provider's Opus is ignored", () => {
  const { profile } = profileForStep(DEFAULT_LOOP_CONFIG, "plan", [kiroOpus, runner], runner.id);
  assert.equal(profile, runner);
  assert.equal(profileForStep(DEFAULT_LOOP_CONFIG, "plan", [opus, kiroOpus, kiro], kiro.id).profile, kiroOpus);
});

test("profileForStep: pr runs on the runner profile", () => {
  assert.equal(profileForStep(DEFAULT_LOOP_CONFIG, "pr", [opus, sonnet, runner], runner.id).profile, runner);
});

test("profileForStep: no profiles falls back to FALLBACK_AGENT_CONFIG", () => {
  const resolved = profileForStep(DEFAULT_LOOP_CONFIG, "plan", [], "");
  assert.equal(resolved.profile, null);
  assert.deepEqual(resolved.config, { ...FALLBACK_AGENT_CONFIG });
});
