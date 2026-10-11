import assert from "node:assert/strict";
import { test } from "node:test";
import { INPUT_USD_PER_TOKEN, MODEL, OUTPUT_USD_PER_TOKEN } from "./corrections";
import { haikuJudge } from "./replay-judge";

const recorded = ["missing test for parse", "uses any in the loader"];
const replay = ["parse has no test", "unrelated naming nit", "loader casts to any"];

type Call = { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } };
function fakeFetch(reply: { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: Call["init"]) => {
    calls.push({ url, init });
    const status = reply.status ?? 200;
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}
const ok = (text: string, usage = { input_tokens: 1000, output_tokens: 200 }) => ({ body: { content: [{ type: "text", text }], usage } });

test("sends one Messages API request with the model and both finding lists", async () => {
  const { fetch, calls } = fakeFetch(ok('{"matches":[],"new":[0,1,2]}'));
  await haikuJudge({ fetch, apiKey: "sk-test" })(recorded, replay);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(init.method, "POST");
  assert.equal(init.headers?.["x-api-key"], "sk-test");
  assert.ok(init.headers?.["anthropic-version"]);
  const body = JSON.parse(init.body ?? "");
  assert.equal(body.model, MODEL);
  assert.match(body.system, /JSON/);
  const prompt = JSON.stringify(body.messages) + body.system;
  for (const f of [...recorded, ...replay]) assert.ok(prompt.includes(f), f);
});

test("returns the matches and prices the usage", async () => {
  const { fetch } = fakeFetch(ok('```json\n{"matches":[[0,0],[2,1]],"new":[1]}\n```', { input_tokens: 2000, output_tokens: 500 }));
  const result = await haikuJudge({ fetch, apiKey: "k" })(recorded, replay);
  assert.deepEqual(result.matches, [[0, 0], [2, 1]]);
  assert.equal(result.costUsd, 2000 * INPUT_USD_PER_TOKEN + 500 * OUTPUT_USD_PER_TOKEN);
});

test("an unusable reply still reports its cost, with matches null", async () => {
  for (const text of ["not json", '{"matches":[[9,0]],"new":[]}']) {
    const { fetch } = fakeFetch(ok(text, { input_tokens: 1000, output_tokens: 100 }));
    const result = await haikuJudge({ fetch, apiKey: "k" })(recorded, replay);
    assert.equal(result.matches, null);
    assert.equal(result.costUsd, 1000 * INPUT_USD_PER_TOKEN + 100 * OUTPUT_USD_PER_TOKEN);
  }
});

test("accepts an async key getter, rejects a missing key and an HTTP error", async () => {
  const { fetch, calls } = fakeFetch(ok('{"matches":[],"new":[]}'));
  await haikuJudge({ fetch, apiKey: async () => "sk-async" })(recorded, replay);
  assert.equal(calls[0].init.headers?.["x-api-key"], "sk-async");
  await assert.rejects(haikuJudge({ fetch, apiKey: "" })(recorded, replay), /api key/i);
  const failing = fakeFetch({ status: 500, body: "boom" });
  await assert.rejects(haikuJudge({ fetch: failing.fetch, apiKey: "k" })(recorded, replay), /500/);
});
