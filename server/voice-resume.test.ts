import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { createVoiceResume, noiseCut, RESUME_MESSAGE, TOOL_RESUME_MESSAGE } from "./voice-resume";

type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];
type Outcome = TurnEnded["outcome"];

const AGENT = { id: "a1", workspaceId: null, parentAgentId: null, provider: "claude", cwd: "/repo", title: null };
const CANCELED: Outcome = { kind: "canceled", reason: "interrupted" };

function toolCall(name: string, status: "running" | "completed" | "failed" | "canceled") {
  return { type: "tool_call", callId: name, name, detail: { type: "unknown", input: null, output: null }, status, error: null };
}

const USER = { type: "user_message", text: "carry on" };

function turnEnded(outcome: Outcome, ...items: (ReturnType<typeof toolCall> | typeof USER)[]): TurnEnded {
  return { agent: AGENT, turnId: "t1", outcome, timeline: items as unknown as TurnEnded["timeline"] };
}

const cut = () => turnEnded(CANCELED, toolCall("Bash", "completed"), toolCall("mcp__paseo__speak", "failed"));

function setup() {
  const sent: [string, string][] = [];
  const resume = createVoiceResume({ send: async (agentId, text) => void sent.push([agentId, text]) }, 1000);
  return { resume, sent };
}

test("a canceled turn ending on an unfinished speak is a speech cut", () => {
  assert.equal(noiseCut(cut()), "speech");
  assert.equal(noiseCut(turnEnded(CANCELED, toolCall("speak", "running"))), "speech");
});

test("a finished speak, a completed turn, or no tool call is not a cut", () => {
  assert.equal(noiseCut(turnEnded(CANCELED, toolCall("mcp__paseo__speak", "completed"))), null);
  assert.equal(noiseCut(turnEnded({ kind: "completed" }, toolCall("mcp__paseo__speak", "failed"))), null);
  assert.equal(noiseCut(turnEnded(CANCELED)), null);
});

test("a canceled turn ending on any other unfinished tool is a tool cut", () => {
  assert.equal(noiseCut(turnEnded(CANCELED, toolCall("mcp__paseo__speak", "completed"), toolCall("Bash", "canceled"))), "tool");
  assert.equal(noiseCut(turnEnded(CANCELED, toolCall("mcp__paseo__speak", "failed"), toolCall("Read", "running"))), "tool");
});

test("an unfinished tool in a session that never spoke is not a cut: it is a typed session's Stop", () => {
  assert.equal(noiseCut(turnEnded(CANCELED, toolCall("Read", "completed"), toolCall("Bash", "canceled"))), null);
});

test("an unfinished tool from before the last user message doesn't make a later canceled turn a cut", () => {
  assert.equal(noiseCut(turnEnded(CANCELED, toolCall("mcp__paseo__speak", "completed"), toolCall("Bash", "canceled"), USER)), null);
  assert.equal(noiseCut(turnEnded(CANCELED, toolCall("mcp__paseo__speak", "failed"), USER)), null);
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

test("after a tool cut with no new turn in the quiet window, the agent is told to run it again", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { resume, sent } = setup();
    resume.onTurnEnded(turnEnded(CANCELED, toolCall("mcp__paseo__speak", "completed"), toolCall("Bash", "canceled")));
    mock.timers.tick(1000);
    await Promise.resolve();
    assert.deepEqual(sent, [["a1", TOOL_RESUME_MESSAGE]]);
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
