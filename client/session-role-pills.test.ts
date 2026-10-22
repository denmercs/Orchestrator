import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeSessionRolePills } from "./session-role-pills";
import { createVoiceRunner } from "./voice-runner";

type Menu = { kind: string; items?: { kind: string; id: string; behavior?: { onPress(): unknown } }[] };
type Button = { label: string; behavior: Menu };
type Reg = { id: string; workspaceId: string; agentId: string; label: string; button: Button; removed: boolean };
type Snapshot = (message: { entries: unknown[] }) => void;
type Update = (message: unknown) => void;

const agent = (id: string, workspaceId: string, extra: Record<string, unknown> = {}) => ({
  id,
  workspaceId,
  title: id,
  status: "idle",
  labels: {},
  ...extra,
});

// A fake Paseo client that records composer pills, and a real voice runner over fake mic ports.
function setup(initial: unknown[]) {
  const regs: Reg[] = [];
  let snapshot: Snapshot = () => {};
  let update: Update = () => {};
  const micCalls: string[] = [];
  const rpcCalls: [string, unknown][] = [];
  const runner = createVoiceRunner({
    link: { say: async () => {}, interrupt: async () => {} },
    ears: {
      open: () => void micCalls.push("open"),
      close: () => void micCalls.push("close"),
      setAwake() {},
      setPaused() {},
      onEvent() {},
    },
    prefs: { read: async () => ({ micOff: false }), write: async () => {} },
  });
  const client = {
    paseo: {
      agents: {
        list: async () => ({
          entries: initial.map((a) => ({ agent: a })),
          subscription: {
            subscribe: (handlers: { snapshot: Snapshot; update: Update }) => {
              snapshot = handlers.snapshot;
              update = handlers.update;
            },
            release: async () => {},
          },
        }),
      },
    },
    rpc: async (rpc: { name: string }, input: unknown) => {
      rpcCalls.push([rpc.name, input]);
      return { modes: {}, ok: true };
    },
    openSurface() {},
    addComposerPill(input: { id: string; workspaceId: string; agentId: string; button: Button }) {
      const reg: Reg = { id: input.id, workspaceId: input.workspaceId, agentId: input.agentId, label: input.button.label, button: input.button, removed: false };
      regs.push(reg);
      return {
        update: (button: Button) => {
          reg.label = button.label;
          reg.button = button;
        },
        remove: () => void (reg.removed = true),
      };
    },
  } as unknown as PluginClientContext;
  const stop = contributeSessionRolePills(client, runner);
  const voicePills = () => regs.filter((r) => r.id === "session-voice" && !r.removed);
  return {
    runner,
    micCalls,
    rpcCalls,
    stop,
    voicePills,
    snapshot: (agents: unknown[]) => snapshot({ entries: agents.map((a) => ({ agent: a })) }),
    upsert: (a: unknown) => update({ type: "agent_update", payload: { kind: "upsert", agent: a } }),
    remove: (agentId: string) => update({ type: "agent_update", payload: { kind: "remove", agentId } }),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test("a session gets a Voice pill that shows the runner's current state", async () => {
  const t = setup([agent("a1", "w1")]);
  await t.runner.start();
  await flush();
  assert.deepEqual(t.voicePills().map((p) => [p.agentId, p.workspaceId, p.label]), [["a1", "w1", "Voice · asleep"]]);
  t.stop();
});

test("a re-delivered session list keeps the pill and does not close the mic", async () => {
  const t = setup([agent("a1", "w1"), agent("a2", "w1")]);
  await t.runner.start();
  await flush();
  const before = t.voicePills();
  t.snapshot([agent("a1", "w1"), agent("a2", "w1")]);
  assert.equal(t.voicePills().length, 2);
  assert.deepEqual(t.voicePills(), before, "same registrations, none removed or re-added");
  assert.deepEqual(t.micCalls, ["open"]);
  assert.equal(t.runner.getState().micOn, true);
  t.stop();
});

test("after navigation the same pill still follows the runner", async () => {
  const t = setup([agent("a1", "w1")]);
  await t.runner.start();
  await flush();
  t.snapshot([agent("a1", "w1")]);
  t.runner.on();
  assert.equal(t.voicePills()[0]?.label, "Voice · listening");
  assert.equal(t.voicePills().length, 1);
  t.stop();
});

test("a session that moves workspace gets its pill there, still live, with the mic open", async () => {
  const t = setup([agent("a1", "w1")]);
  await t.runner.start();
  t.runner.on();
  await flush();
  t.upsert(agent("a1", "w2"));
  assert.deepEqual(t.voicePills().map((p) => [p.workspaceId, p.label]), [["w2", "Voice · listening"]]);
  assert.deepEqual(t.micCalls, ["open"]);
  t.stop();
});

test("Voice's own sessions get no pill, and a removed session loses only its own", async () => {
  const t = setup([agent("a1", "w1"), agent("a2", "w1"), agent("j1", "w1", { provider: "jarvis" })]);
  await t.runner.start();
  await flush();
  assert.deepEqual(t.voicePills().map((p) => p.agentId).sort(), ["a1", "a2"]);
  t.remove("a1");
  assert.deepEqual(t.voicePills().map((p) => p.agentId), ["a2"]);
  t.stop();
});

test("stopping removes every pill and stops following the runner", async () => {
  const t = setup([agent("a1", "w1")]);
  await t.runner.start();
  await flush();
  const reg = t.voicePills()[0];
  t.stop();
  assert.equal(t.voicePills().length, 0);
  t.runner.on();
  assert.equal(reg?.label, "Voice · asleep");
});

// Presses the menu item `id` on `agentId`'s voice pill.
async function press(t: ReturnType<typeof setup>, agentId: string, id: string) {
  const pill = t.voicePills().find((p) => p.agentId === agentId);
  const item = pill?.button.behavior.items?.find((entry) => entry.id === id);
  assert.ok(item?.behavior, `no ${id} item on ${agentId}`);
  await item.behavior.onPress();
}

test("the voice pill's menu talks to the session and switches how its replies are spoken", async () => {
  const t = setup([agent("a1", "w1"), agent("a2", "w1")]);
  await t.runner.start();
  await flush();
  await press(t, "a1", "talk");
  assert.equal(t.runner.getState().session?.id, "a1");
  await press(t, "a2", "talk");
  assert.equal(t.runner.getState().session?.id, "a2", "a second pick replaces the first");
  await press(t, "a1", "speak-medium");
  assert.deepEqual(t.rpcCalls.at(-1), ["orchestration.speak-replies.set", { agentId: "a1", mode: "medium" }]);
  assert.equal(t.voicePills().find((p) => p.agentId === "a1")?.label, "Voice · asleep · speak medium");
  t.stop();
});

test("a worker's voice pill offers talk only", async () => {
  const t = setup([agent("h1", "w1"), agent("k1", "w1", { labels: { "paseo.parent-agent-id": "h1" } })]);
  await t.runner.start();
  await flush();
  const ids = t.voicePills().find((p) => p.agentId === "k1")?.button.behavior.items?.map((entry) => entry.id);
  assert.deepEqual(ids, ["talk"]);
  t.stop();
});
