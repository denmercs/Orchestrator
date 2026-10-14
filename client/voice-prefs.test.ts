import assert from "node:assert/strict";
import { test } from "node:test";
import { createVoicePrefs } from "./voice-prefs";

const prefsWith = (answer: () => unknown) => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const rpc = (async (contract: { name: string }, input: unknown) => {
    calls.push({ name: contract.name, input });
    return answer();
  }) as never;
  return { prefs: createVoicePrefs(rpc), calls };
};

test("read: a ready setting gives micOff and is readable", async () => {
  const { prefs } = prefsWith(() => ({ status: "ready", revision: "1", values: { micOff: true } }));
  assert.deepEqual(await prefs.read(), { micOff: true, unreadable: false });
});

test("read: an invalid setting is unreadable and defaults to the mic on", async () => {
  const { prefs } = prefsWith(() => ({ status: "invalid", revision: "1", error: "corrupt" }));
  assert.deepEqual(await prefs.read(), { micOff: false, unreadable: true });
});

test("read: a rejecting rpc is transient, not unreadable, so the caller keeps its last value", async () => {
  const { prefs } = prefsWith(() => Promise.reject(new Error("rpc down")));
  assert.deepEqual(await prefs.read(), { micOff: false, unreadable: false, transient: true });
});

test("repair re-saves the defaults over an invalid setting using its revision", async () => {
  const { prefs, calls } = prefsWith(() => ({ status: "invalid", revision: "r7", error: "corrupt" }));
  await prefs.repair();
  assert.equal((calls.find((c) => c.name.endsWith("write"))?.input as { values: { micOff: boolean } }).values.micOff, false, "no value ever read defaults to false");
  calls.length = 0;
  await prefs.repair(true);
  const write = calls.find((c) => c.name.endsWith("write"));
  assert.ok(write, "wrote");
  assert.equal((write.input as { revision: string }).revision, "r7");
  assert.equal((write.input as { values: { micOff: boolean } }).values.micOff, true, "repair rewrites the last known value");
});
