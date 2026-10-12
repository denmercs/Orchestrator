import assert from "node:assert/strict";
import { test } from "node:test";
import { createVoiceLink, INTERRUPT_MESSAGE } from "./voice-link";
import { VOICE_ROUTING_PREAMBLE, VOICE_SESSION_ENV } from "../shared/voice-session";

type Sent = { id: string; text: string; options?: { activeTurnBehavior?: string } };

function fakeAgents(workspace: string | null = "ws1") {
  const sent: Sent[] = [];
  const created: Array<Record<string, unknown>> = [];
  const make = (via: string) => async (options: Record<string, unknown>) => {
    created.push({ via, ...options });
    return { id: "new1" };
  };
  const agents = {
    create: make("agents"),
    ref: (id: string) => ({
      refresh: async () => ({ agent: { cwd: "/repo", provider: "claude", workspaceId: workspace } }),
      send: async (text: string, options?: { activeTurnBehavior?: "steer" | "interrupt" }) => {
        sent.push({ id, text, options });
      },
    }),
  };
  const workspaces = { ref: (id: string) => ({ agents: { create: make(`workspace:${id}`) } }) };
  return { agents, sent, created, paseo: { agents, workspaces } };
}

test("say steers the text into the session's running turn", async () => {
  const { paseo, sent } = fakeAgents();
  const link = createVoiceLink(paseo);
  await link.create({ id: "a1" });
  await link.say("new1", "run the tests");
  assert.deepEqual(sent, [{ id: "new1", text: "run the tests", options: { activeTurnBehavior: "steer" } }]);
});

test("interrupt is the only path that sends an interrupt", async () => {
  const { paseo, sent } = fakeAgents();
  const link = createVoiceLink(paseo);
  await link.say("a1", "stop");
  await link.say("a1", "interrupt");
  assert.ok(sent.every((s) => s.options?.activeTurnBehavior === "steer"));
  await link.interrupt("a2");
  assert.deepEqual(sent[2], {
    id: "a2",
    text: "Stopped from the Voice drawer. Wait for my next message.",
    options: { activeTurnBehavior: "interrupt" },
  });
  assert.equal(INTERRUPT_MESSAGE, sent[2].text);
  assert.equal(sent.filter((s) => s.options?.activeTurnBehavior === "interrupt").length, 1);
});

test("create starts a marked session in the target's workspace on its provider and returns its id", async () => {
  const { paseo, created } = fakeAgents();
  const id = await createVoiceLink(paseo).create({ id: "a1" });
  assert.equal(id, "new1");
  assert.deepEqual(created, [{ via: "workspace:ws1", config: { provider: "claude" }, env: { [VOICE_SESSION_ENV]: "1" } }]);
});

test("create without a workspace uses the target's folder", async () => {
  const { paseo, created } = fakeAgents(null);
  await createVoiceLink(paseo).create({ id: "a1" });
  assert.deepEqual(created, [{ via: "agents", cwd: "/repo", config: { provider: "claude" }, env: { [VOICE_SESSION_ENV]: "1" } }]);
});

test("the first steer to a session this link did not create carries the routing preamble, later steers do not", async () => {
  const { paseo, sent } = fakeAgents();
  const link = createVoiceLink(paseo);
  await link.say("a1", "run the tests");
  await link.say("a1", "and lint");
  await link.say("a2", "hello");
  assert.equal(sent[0].text, `${VOICE_ROUTING_PREAMBLE}\n\nrun the tests`);
  assert.equal(sent[1].text, "and lint");
  assert.equal(sent[2].text, `${VOICE_ROUTING_PREAMBLE}\n\nhello`);
});

test("a session this link created never gets the preamble", async () => {
  const { paseo, sent } = fakeAgents();
  const link = createVoiceLink(paseo);
  const id = await link.create({ id: "a1" });
  await link.say(id, "go");
  assert.equal(sent[0].text, "go");
});
