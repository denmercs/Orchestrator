import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { permissionEvents, turnEvents } from "./voice-turns";

type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];
type Permission = PluginLifecycleEvents["agent.permission_requested"];

const AGENT = { id: "a1", workspaceId: null, parentAgentId: null, provider: "claude", cwd: "/repo", title: null };
const user = (text: string) => ({ type: "user_message", text });
const said = (text: string) => ({ type: "assistant_message", text });
const tool = { type: "tool_call", callId: "c1", name: "Bash" };

function turnEnded(outcome: TurnEnded["outcome"], timeline: unknown[], agent: TurnEnded["agent"] = AGENT): TurnEnded {
  return { agent, turnId: "t1", outcome, timeline: timeline as unknown as TurnEnded["timeline"] };
}

test("a completed turn replies with the final assistant message after the last user message, then finished", () => {
  const timeline = [said("old answer"), user("do it"), said("working on it"), tool, said("All done.")];
  assert.deepEqual(turnEvents(turnEnded({ kind: "completed" }, timeline)), [
    { type: "reply", sessionId: "a1", text: "All done." },
    { type: "notice", kind: "finished", sessionId: "a1" },
  ]);
});

test("a completed turn with no assistant message since the last user message only finishes", () => {
  const timeline = [said("old answer"), user("do it"), tool];
  assert.deepEqual(turnEvents(turnEnded({ kind: "completed" }, timeline)), [{ type: "notice", kind: "finished", sessionId: "a1" }]);
});

test("a failed turn is an error notice, with no reply", () => {
  const outcome = { kind: "failed", error: { message: "boom" } } as const;
  assert.deepEqual(turnEvents(turnEnded(outcome, [user("go"), said("partial")])), [{ type: "notice", kind: "error", sessionId: "a1" }]);
});

test("a canceled turn says nothing", () => {
  assert.deepEqual(turnEvents(turnEnded({ kind: "canceled", reason: "interrupted" }, [user("go"), said("partial")])), []);
});

test("a permission request is a needsYou notice", () => {
  const event = { agent: AGENT, request: { id: "p1" } } as unknown as Permission;
  assert.deepEqual(permissionEvents(event), [{ type: "notice", kind: "needsYou", sessionId: "a1" }]);
});

test("Voice's own sessions (Jarvis, the Voice helper) say nothing", () => {
  const jarvis = { ...AGENT, id: "j1", provider: "jarvis" };
  const helper = { ...AGENT, id: "h1", labels: { kind: "voice-helper" } } as TurnEnded["agent"];
  for (const agent of [jarvis, helper]) {
    assert.deepEqual(turnEvents(turnEnded({ kind: "completed" }, [user("hi"), said("hello")], agent)), []);
    assert.deepEqual(permissionEvents({ agent, request: {} } as unknown as Permission), []);
  }
});
