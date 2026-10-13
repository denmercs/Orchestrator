import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentProfile } from "./agent-profiles";
import { applyVoiceSession, VOICE_ROUTING_RULE, VOICE_SESSION_ENV, voiceChipId, voiceModelLine, voiceProfileFor, type VoiceRequest } from "./voice-session";

const opus: AgentProfile = { id: "p_opus", name: "default", provider: "claude", model: "claude-opus-5-5" };
const sonnet: AgentProfile = { id: "p_sonnet", name: "Claude | Sonnet 5.5 - Coding", provider: "claude", model: "claude-sonnet-5-5" };
const kiroSonnet: AgentProfile = { id: "p_kiro", name: "Kiro Sonnet", provider: "kiro", model: "sonnet" };

test("the voice session marker is a named env var set to 1", () => {
  assert.equal(VOICE_SESSION_ENV, "ORCHESTRATOR_VOICE_SESSION");
});

test("Auto picks the first Claude profile whose model or name says sonnet", () => {
  assert.equal(voiceProfileFor([opus, kiroSonnet, sonnet], ""), sonnet);
});

test("Auto matches a Sonnet name when the model is empty", () => {
  const named: AgentProfile = { id: "p_named", name: "Sonnet fast", provider: "claude", model: null };
  assert.equal(voiceProfileFor([opus, named], ""), named);
});

test("Auto returns null when no Claude profile is Sonnet", () => {
  assert.equal(voiceProfileFor([opus, kiroSonnet], ""), null);
});

test("a set profile id or name wins over Auto", () => {
  assert.equal(voiceProfileFor([opus, sonnet], "p_opus"), opus);
  assert.equal(voiceProfileFor([opus, sonnet], "default"), opus);
});

test("off disables the voice profile", () => {
  assert.equal(voiceProfileFor([opus, sonnet], "off"), null);
});

test("an unknown name or no profiles gives null", () => {
  assert.equal(voiceProfileFor([opus, sonnet], "nope"), null);
  assert.equal(voiceProfileFor([], ""), null);
  assert.equal(voiceProfileFor([], "p_opus"), null);
});

const full: AgentProfile = {
  id: "p_full",
  name: "Full",
  provider: "claude",
  model: "claude-sonnet-5-5",
  modeId: "auto",
  thinkingOptionId: "high",
};
const req = (config: Partial<VoiceRequest["config"]>, env?: Record<string, string>): VoiceRequest => ({
  config: { provider: "claude", ...config },
  env,
});
const marked = { [VOICE_SESSION_ENV]: "1" };

test("a marked request with no model gets the profile and the rule after the existing prompt", () => {
  const out = applyVoiceSession(req({ systemPrompt: "base" }, marked), full);
  assert.equal(out.config.provider, "claude");
  assert.equal(out.config.model, "claude-sonnet-5-5");
  assert.equal(out.config.modeId, "auto");
  assert.equal(out.config.thinkingOptionId, "high");
  assert.equal(out.config.systemPrompt, `base\n\n${VOICE_ROUTING_RULE}`);
  assert.deepEqual(out.env, marked);
});

test("a marked request with no system prompt gets just the rule", () => {
  const out = applyVoiceSession(req({}, marked), full);
  assert.equal(out.config.systemPrompt, VOICE_ROUTING_RULE);
});

test("a marked request with a model keeps it but still gets the rule", () => {
  const out = applyVoiceSession(req({ provider: "kiro", model: "mine", modeId: "plan" }, marked), full);
  assert.equal(out.config.provider, "kiro");
  assert.equal(out.config.model, "mine");
  assert.equal(out.config.modeId, "plan");
  assert.equal(out.config.thinkingOptionId, undefined);
  assert.equal(out.config.systemPrompt, VOICE_ROUTING_RULE);
});

test("a null profile adds only the rule", () => {
  const out = applyVoiceSession(req({}, marked), null);
  assert.deepEqual(out.config, { provider: "claude", systemPrompt: VOICE_ROUTING_RULE });
});

test("an unmarked request comes back identical", () => {
  const request = req({}, { OTHER: "1" });
  assert.equal(applyVoiceSession(request, full), request);
  const bare = req({});
  assert.equal(applyVoiceSession(bare, full), bare);
  const zero = req({}, { [VOICE_SESSION_ENV]: "0" });
  assert.equal(applyVoiceSession(zero, full), zero);
});

test("the routing rule names the loop, helpers, one Opus helper and numbered choices", () => {
  assert.match(VOICE_ROUTING_RULE, /Plan → Implement → Review/);
  assert.match(VOICE_ROUTING_RULE, /Sonnet/);
  assert.match(VOICE_ROUTING_RULE, /Haiku/);
  assert.match(VOICE_ROUTING_RULE, /background/i);
  assert.match(VOICE_ROUTING_RULE, /at most one Opus/i);
  assert.match(VOICE_ROUTING_RULE, /numbered/i);
});

test("voiceModelLine names the profile's caption, or says the default is off", () => {
  assert.equal(
    voiceModelLine(sonnet, ""),
    "Voice sessions run on Claude | Sonnet 5.5 - Coding · claude/claude-sonnet-5-5",
  );
  assert.equal(voiceModelLine(null, "off"), "Voice sessions: default off");
  assert.equal(voiceModelLine(sonnet, "off"), "Voice sessions: default off");
  assert.equal(voiceModelLine(null, ""), "Voice sessions run on the Paseo default");
});

test("voiceChipId picks Off, Auto or the named profile, and no chip for a profile that is gone", () => {
  const profiles = [opus, sonnet];
  assert.equal(voiceChipId(profiles, "off"), "off");
  assert.equal(voiceChipId(profiles, " OFF "), "off");
  assert.equal(voiceChipId(profiles, ""), "");
  assert.equal(voiceChipId(profiles, "p_sonnet"), "p_sonnet");
  assert.equal(voiceChipId(profiles, "Claude | Sonnet 5.5 - Coding"), "p_sonnet");
  // The hook leaves a missing profile on the Paseo default, so Auto must not light up for it.
  assert.equal(voiceChipId(profiles, "p_deleted"), "p_deleted");
});
