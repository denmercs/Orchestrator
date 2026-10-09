import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentProfile } from "../shared/agent-profiles";
import type { StoryContext } from "../shared/context";
import { DEFAULT_LOOP_CONFIG, type LoopConfig } from "../shared/initiative-loop";
import { contextBlock, ctaAction, stepModels } from "./selected-story-model";

const opus: AgentProfile = { id: "p-opus", name: "Deep", provider: "claude", model: "opus" };
const sonnet: AgentProfile = { id: "p-sonnet", name: "Fast", provider: "claude", model: "sonnet" };
const custom: AgentProfile = { id: "p-custom", name: "Custom", provider: "claude", model: "haiku" };
const runner: AgentProfile = { id: "p-runner", name: "default", provider: "claude", model: null };

function loopWith(profiles: Partial<LoopConfig["profiles"]>): LoopConfig {
  return { ...DEFAULT_LOOP_CONFIG, profiles: { ...DEFAULT_LOOP_CONFIG.profiles, ...profiles } };
}

test("stepModels: five labels in stepBar order; a set profile wins, else the d1 tier", () => {
  const labels = stepModels(loopWith({ plan: custom.id }), [opus, sonnet, custom, runner], runner.id);
  assert.deepEqual(labels, ["haiku", "sonnet", "opus", "—", "sonnet"]);
});

test("stepModels: CI watch shows the fix profile", () => {
  const labels = stepModels(loopWith({ fix: opus.id }), [opus, sonnet, runner], runner.id);
  assert.equal(labels[4], "opus");
});

test("stepModels: no tier match falls back to the runner, labelled by name without a model", () => {
  assert.deepEqual(stepModels(DEFAULT_LOOP_CONFIG, [runner], runner.id), [
    "default",
    "default",
    "default",
    "—",
    "default",
  ]);
});

test("stepModels: Auto when no profile resolves", () => {
  assert.deepEqual(stepModels(DEFAULT_LOOP_CONFIG, [], ""), ["Auto", "Auto", "Auto", "—", "Auto"]);
});

function ctx(overrides: Partial<StoryContext> = {}): StoryContext {
  return {
    agentId: "a1",
    step: "implement",
    used: 84_000,
    max: 200_000,
    percent: 42,
    level: "ok",
    session: 2,
    compactions: 1,
    burn: 3_800,
    turnsToAct: 17,
    markers: {
      warn: { tokens: 100_000, percent: 50 },
      act: { tokens: 150_000, percent: 75, word: "compact" },
    },
    split: { system: 18_000, conversation: 38_000, tool: 28_000 },
    costUsd: 2.4,
    ...overrides,
  };
}

test("contextBlock: header, used/max, split widths as % of max, ticks, legend with approx., cost, burn, policy", () => {
  const block = contextBlock(ctx(), 2.4, 5);
  assert.equal(block.header, "Context · Implement session 2");
  assert.equal(block.usedLabel, "84k / 200k");
  assert.deepEqual(block.bars, [
    { key: "system", width: 9 },
    { key: "conversation", width: 19 },
    { key: "tool", width: 14 },
  ]);
  assert.equal(block.warnAt, 50);
  assert.equal(block.actAt, 75);
  assert.equal(block.actWord, "compact");
  assert.deepEqual(block.legend, ["System + skills 18k", "Conversation 38k", "Tool output 28k", "approx."]);
  assert.equal(block.compactionNote, "Compacted 1× this session");
  assert.equal(block.cost, "$2.40");
  assert.equal(block.cap, "cap $5.00");
  assert.equal(block.burn, "~3.8k / turn");
  assert.equal(block.hitsLabel, "Hits 75% in");
  assert.equal(block.turnsLeft, "~17 turns");
  assert.equal(block.turnsTone, "default");
  assert.equal(block.policy, "Implement: warn at 50%, compact at 75%.");
});

test("contextBlock: fresh strategy says hand off; no compactions, no note", () => {
  const block = contextBlock(
    ctx({
      compactions: 0,
      markers: {
        warn: { tokens: 100_000, percent: 50 },
        act: { tokens: 150_000, percent: 75, word: "hand off" },
      },
    }),
    2.4,
    5,
  );
  assert.equal(block.actWord, "hand off");
  assert.equal(block.compactionNote, "");
  assert.equal(block.policy, "Implement: warn at 50%, hand off at 75%.");
});

test("contextBlock: null split is one bar and a Used legend without approx.", () => {
  const block = contextBlock(ctx({ split: null, used: 148_000 }), 2.4, 5);
  assert.deepEqual(block.bars, [{ key: "used", width: 74 }]);
  assert.deepEqual(block.legend, ["Used 148k"]);
});

test("contextBlock: null burn shows a dash; turns-left unknown in the default tone", () => {
  const block = contextBlock(ctx({ burn: null, turnsToAct: null }), 2.4, 5);
  assert.equal(block.burn, "—");
  assert.equal(block.turnsLeft, "—");
  assert.equal(block.turnsTone, "default");
});

test("contextBlock: now and under 10 turns are amber", () => {
  const now = contextBlock(ctx({ turnsToAct: "now" }), 2.4, 5);
  assert.equal(now.turnsLeft, "now");
  assert.equal(now.turnsTone, "amber");
  const soon = contextBlock(ctx({ turnsToAct: 9 }), 2.4, 5);
  assert.equal(soon.turnsLeft, "~9 turns");
  assert.equal(soon.turnsTone, "amber");
  assert.equal(contextBlock(ctx({ turnsToAct: 10 }), 2.4, 5).turnsTone, "default");
});

test("contextBlock: null cost shows a dash; the cap still shows", () => {
  const block = contextBlock(ctx({ costUsd: null }), null, 5);
  assert.equal(block.cost, "—");
  assert.equal(block.cap, "cap $5.00");
});

const repo = "https://github.com/o/r";
const running = { agent: "a1", pr: 12 };

test("ctaAction: Open session and Review plan open the story's agent", () => {
  assert.deepEqual(ctaAction("Open session", running, repo), { kind: "agent", agentId: "a1" });
  assert.deepEqual(ctaAction("Review plan", running, repo), { kind: "agent", agentId: "a1" });
});

test("ctaAction: Open PR and Review & merge open the PR URL", () => {
  const pr = { kind: "pr", url: "https://github.com/o/r/pull/12" };
  assert.deepEqual(ctaAction("Open PR", running, repo), pr);
  assert.deepEqual(ctaAction("Review & merge", running, repo), pr);
});

test("ctaAction: Start agent starts the loop; View plan opens Details", () => {
  const idle = { agent: "", pr: null };
  assert.deepEqual(ctaAction("Start agent", idle, repo), { kind: "start" });
  assert.deepEqual(ctaAction("View plan", idle, repo), { kind: "details" });
});

test("ctaAction: no agent, no PR URL, no CTA or an unknown one → hidden", () => {
  assert.equal(ctaAction("Open session", { agent: "", pr: 12 }, repo), null);
  assert.equal(ctaAction("Review plan", { agent: "", pr: 12 }, repo), null);
  assert.equal(ctaAction("Open PR", { agent: "a1", pr: null }, repo), null);
  assert.equal(ctaAction("Review & merge", running, ""), null);
  assert.equal(ctaAction(null, running, repo), null);
  assert.equal(ctaAction("Something else", running, repo), null);
});
