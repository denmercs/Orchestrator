import assert from "node:assert/strict";
import { test } from "node:test";
import type { VoiceEvent } from "../shared/voice-loop";
import { createVoiceHub, HUB_KEEP, READ_WAIT_MS, type HubPorts } from "./voice-turns";

const note = (n: number): VoiceEvent => ({ type: "notice", kind: "finished", sessionId: `s${n}` });

function fake() {
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const ports: HubPorts = {
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
  };
  return { ports, timers, fire: () => timers.filter((t) => t.live).forEach((t) => t.fn()) };
}

test("each event gets a rising cursor", () => {
  const hub = createVoiceHub(fake().ports);
  assert.equal(hub.publish(note(1)), 1);
  assert.equal(hub.publish(note(2)), 2);
  assert.equal(hub.cursor(), 2);
});

test("read answers at once when events exist past the cursor", async () => {
  const f = fake();
  const hub = createVoiceHub(f.ports);
  hub.publish(note(1));
  hub.publish(note(2));
  assert.deepEqual(await hub.read(0), { cursor: 2, events: [note(1), note(2)] });
  assert.deepEqual(await hub.read(1), { cursor: 2, events: [note(2)] });
  assert.equal(f.timers.length, 0);
});

test("read waits for the limit and answers empty when nothing arrives", async () => {
  const f = fake();
  const hub = createVoiceHub(f.ports);
  hub.publish(note(1));
  const pending = hub.read(1);
  assert.equal(f.timers[0].ms, READ_WAIT_MS);
  assert.equal(READ_WAIT_MS, 20_000);
  f.fire();
  assert.deepEqual(await pending, { cursor: 1, events: [] });
});

test("a waiting read resolves early when a new event arrives, and stops its timer", async () => {
  const f = fake();
  const hub = createVoiceHub(f.ports);
  const pending = hub.read(0);
  hub.publish(note(1));
  assert.deepEqual(await pending, { cursor: 1, events: [note(1)] });
  assert.equal(f.timers[0].live, false);
});

test("the hub keeps the last 50 events", async () => {
  const hub = createVoiceHub(fake().ports);
  assert.equal(HUB_KEEP, 50);
  for (let n = 1; n <= 60; n++) hub.publish(note(n));
  const { cursor, events } = await hub.read(0);
  assert.equal(cursor, 60);
  assert.equal(events.length, 50);
  assert.deepEqual(events[0], note(11));
});

test("listeners get each event until they unsubscribe", () => {
  const hub = createVoiceHub(fake().ports);
  const seen: VoiceEvent[] = [];
  const off = hub.subscribe((e) => seen.push(e));
  hub.publish(note(1));
  off();
  hub.publish(note(2));
  assert.deepEqual(seen, [note(1)]);
});
