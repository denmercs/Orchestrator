import assert from "node:assert/strict";
import { test } from "node:test";
import { createVoiceLink, INTERRUPT_MESSAGE } from "./voice-link";

type Sent = { id: string; text: string; options?: { activeTurnBehavior?: string } };

function fakeAgents() {
  const sent: Sent[] = [];
  const agents = {
    ref: (id: string) => ({
      send: async (text: string, options?: { activeTurnBehavior?: "steer" | "interrupt" }) => {
        sent.push({ id, text, options });
      },
    }),
  };
  return { agents, sent };
}

test("say steers the text into the session's running turn", async () => {
  const { agents, sent } = fakeAgents();
  await createVoiceLink(agents).say("a1", "run the tests");
  assert.deepEqual(sent, [{ id: "a1", text: "run the tests", options: { activeTurnBehavior: "steer" } }]);
});

test("interrupt is the only path that sends an interrupt", async () => {
  const { agents, sent } = fakeAgents();
  const link = createVoiceLink(agents);
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
