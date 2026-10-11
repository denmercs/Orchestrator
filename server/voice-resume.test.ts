import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { createVoiceResume, cutMidSpeech, RESUME_MESSAGE } from "./voice-resume";

type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];
type Outcome = TurnEnded["outcome"];

const AGENT = { id: "a1", workspaceId: null, parentAgentId: null, provider: "claude", cwd: "/repo", title: null };
const CANCELED: Outcome = { kind: "canceled", reason: "interrupted" };

function toolCall(name: string, status: "running" | "completed" | "failed" | "canceled") {
  return { type: "tool_call", callId: name, name, detail: { type: "unknown", input: null, output: null }, status, error: null };
}

function turnEnded(outcome: Outcome, ...calls: ReturnType<typeof toolCall>[]): TurnEnded {
  return { agent: AGENT, turnId: "t1", outcome, timeline: calls as unknown as TurnEnded["timeline"] };
}

const cut = () => turnEnded(CANCELED, toolCall("Bash", "completed"), toolCall("mcp__paseo__speak", "failed"));

function setup() {
  const sent: [string, string][] = [];
  const resume = createVoiceResume({ send: async (agentId, text) => void sent.push([agentId, text]) }, 1000);
  return { resume, sent };
}

test("a canceled turn ending on an unfinished speak is a cut", () => {
  assert.equal(cutMidSpeech(cut()), true);
  assert.equal(cutMidSpeech(turnEnded(CANCELED, toolCall("speak", "running"))), true);
});

test("a finished speak, a non-speak tool, or a completed turn is not a cut", () => {
  assert.equal(cutMidSpeech(turnEnded(CANCELED, toolCall("mcp__paseo__speak", "completed"))), false);
  assert.equal(cutMidSpeech(turnEnded(CANCELED, toolCall("mcp__paseo__speak", "failed"), toolCall("Bash", "canceled"))), false);
  assert.equal(cutMidSpeech(turnEnded({ kind: "completed" }, toolCall("mcp__paseo__speak", "failed"))), false);
  assert.equal(cutMidSpeech(turnEnded(CANCELED)), false);
});

test("after a cut with no new turn in the quiet window, the agent is told to finish", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { resume, sent } = setup();
    resume.onTurnEnded(cut());
    mock.timers.tick(999);
    assert.deepEqual(sent, []);
    mock.timers.tick(1);
    await Promise.resolve();
    assert.deepEqual(sent, [["a1", RESUME_MESSAGE]]);
  } finally {
    mock.timers.reset();
  }
});

test("a new turn in the quiet window means the user spoke, so no resume", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { resume, sent } = setup();
    resume.onTurnEnded(cut());
    resume.onTurnStarted("a1");
    mock.timers.tick(5000);
    assert.deepEqual(sent, []);
  } finally {
    mock.timers.reset();
  }
});

test("a resume that is cut again is not resumed a second time", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { resume, sent } = setup();
    resume.onTurnEnded(cut());
    mock.timers.tick(1000);
    await Promise.resolve();
    resume.onTurnStarted("a1");
    resume.onTurnEnded(cut());
    mock.timers.tick(5000);
    assert.equal(sent.length, 1);
    // A clean turn after that re-arms it.
    resume.onTurnEnded(turnEnded({ kind: "completed" }));
    resume.onTurnEnded(cut());
    mock.timers.tick(1000);
    await Promise.resolve();
    assert.equal(sent.length, 2);
  } finally {
    mock.timers.reset();
  }
});
