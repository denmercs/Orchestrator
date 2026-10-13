import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { voiceHelperStart, voiceHelperStop, voiceHelperSwitch, voiceInterpret } from "../shared/voice-rpc";
import { createVoiceHelperClient, HELPER_TRANSPORT_TIMEOUT_MS } from "./voice-helper-client";

const ctx = { sessionId: "s1", sessions: [{ id: "s1", name: "planning" }] };

function setup(impl: (def: unknown, input: unknown) => Promise<unknown>) {
  const calls: { def: unknown; input: unknown }[] = [];
  const rpc = (def: unknown, input: unknown) => {
    calls.push({ def, input });
    return impl(def, input);
  };
  return { calls, client: createVoiceHelperClient(rpc as never) };
}

test("starts and stops the helper over its RPCs", async () => {
  const { calls, client } = setup(async () => ({ ok: true }));
  await client.start();
  await client.stop();
  assert.deepEqual(calls, [
    { def: voiceHelperStart, input: {} },
    { def: voiceHelperStop, input: {} },
  ]);
});

test("reads and sets the switch", async () => {
  let on = true;
  const { calls, client } = setup(async (_def, input) => {
    const { enabled } = input as { enabled?: boolean };
    if (enabled !== undefined) on = enabled;
    return { enabled: on };
  });
  assert.equal(await client.getEnabled(), true);
  assert.equal(await client.setEnabled(false), false);
  assert.equal(await client.getEnabled(), false);
  assert.deepEqual(calls.slice(0, 2), [
    { def: voiceHelperSwitch, input: {} },
    { def: voiceHelperSwitch, input: { enabled: false } },
  ]);
});

test("interprets over the RPC and returns the server's outcome", async () => {
  const outcome = { result: { type: "send", text: "run the tests" }, via: "helper" };
  const { calls, client } = setup(async () => outcome);
  assert.deepEqual(await client.interpret("um run the tests", ctx), outcome);
  assert.deepEqual(calls, [{ def: voiceInterpret, input: { transcript: "um run the tests", ...ctx } }]);
});

test("falls back to the words as heard (reason error) when the RPC rejects", async () => {
  const { client } = setup(async () => {
    throw new Error("down");
  });
  assert.deepEqual(await client.interpret("Jarvis, run the tests", ctx), {
    result: { type: "send", text: "run the tests" },
    via: "passThrough",
    reason: "error",
  });
});

test("falls back with reason timeout when the RPC hangs past 5 s", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { client } = setup(() => new Promise(() => {}));
    let outcome: unknown;
    void client.interpret("run the tests", ctx).then((o) => (outcome = o));
    mock.timers.tick(HELPER_TRANSPORT_TIMEOUT_MS - 1);
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(outcome, undefined);
    mock.timers.tick(1);
    await new Promise<void>((r) => setImmediate(r));
    assert.deepEqual(outcome, { result: { type: "send", text: "run the tests" }, via: "passThrough", reason: "timeout" });
    assert.equal(HELPER_TRANSPORT_TIMEOUT_MS, 5000);
  } finally {
    mock.timers.reset();
  }
});
