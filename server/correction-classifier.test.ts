import assert from "node:assert/strict";
import { test } from "node:test";
import { INPUT_USD_PER_TOKEN, MAX_TOKENS, MODEL, OUTPUT_USD_PER_TOKEN, type Observation } from "../shared/corrections";
import { CORRECTION_CATEGORIES } from "../shared/memory";
import { haikuClassifier } from "./correction-classifier";

const obs = (id: string, text: string): Observation => ({ id, source: "finding", story: "S1", date: "2026-01-01", link: "l", text });
const batch = [obs("a1", "missing test for parse"), obs("b2", "uses any")];
const context = { areas: ["server", "shared"], phrases: { testing: ["add a regression test"], types: ["avoid any"] } };

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

test("sends the Messages API request with categories, areas, vocabulary and the observations", async () => {
  const { fetch, calls } = fakeFetch(ok('{"filings":[]}'));
  await haikuClassifier({ fetch, apiKey: "sk-test" })(batch, context);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(init.method, "POST");
  assert.equal(init.headers?.["x-api-key"], "sk-test");
  assert.ok(init.headers?.["anthropic-version"]);
  assert.equal(init.headers?.["content-type"], "application/json");
  const body = JSON.parse(init.body ?? "");
  assert.equal(body.model, MODEL);
  assert.equal(body.max_tokens, MAX_TOKENS);
  for (const category of CORRECTION_CATEGORIES) assert.ok(body.system.includes(category), category);
  for (const area of context.areas) assert.ok(body.system.includes(area), area);
  assert.ok(body.system.includes("add a regression test") && body.system.includes("avoid any"));
  assert.match(body.system, /JSON/);
  const user = body.messages[0];
  assert.equal(user.role, "user");
  for (const o of batch) assert.ok(user.content.includes(o.id) && user.content.includes(o.text));
});

test("parses the reply, tolerates a json fence, skips entries without an id or phrase, and prices the usage", async () => {
  const filings = [
    { id: "a1", category: "testing", area: "server", phrase: "add a regression test" },
    { id: "b2", category: "types", area: null, phrase: "avoid any" },
    { category: "types", area: null, phrase: "no id" },
    { id: "c3", category: "types", area: null },
  ];
  const { fetch } = fakeFetch(ok("```json\n" + JSON.stringify({ filings }) + "\n```", { input_tokens: 2000, output_tokens: 500 }));
  const result = await haikuClassifier({ fetch, apiKey: "k" })(batch, context);
  assert.deepEqual(result.filings, [filings[0], filings[1]]);
  assert.equal(result.costUsd, 2000 * INPUT_USD_PER_TOKEN + 500 * OUTPUT_USD_PER_TOKEN);
  assert.ok(Math.abs(result.costUsd - 0.0045) < 1e-12);
});

test("accepts an apiKey getter, sync or async", async () => {
  for (const apiKey of [() => "sk-sync", async () => "sk-async"]) {
    const { fetch, calls } = fakeFetch(ok('{"filings":[]}'));
    await haikuClassifier({ fetch, apiKey })(batch, context);
    assert.match(calls[0].init.headers?.["x-api-key"] ?? "", /^sk-(sync|async)$/);
  }
});

test("a missing key throws before any request", async () => {
  const { fetch, calls } = fakeFetch(ok("{}"));
  await assert.rejects(haikuClassifier({ fetch, apiKey: "" })(batch, context), /api key/i);
  await assert.rejects(haikuClassifier({ fetch, apiKey: async () => "" })(batch, context), /api key/i);
  assert.equal(calls.length, 0);
});

test("a non-2xx reply throws with the status and a snippet of the body, never the key", async () => {
  const { fetch } = fakeFetch({ status: 429, body: "rate limited: slow down" });
  await assert.rejects(haikuClassifier({ fetch, apiKey: "sk-secret" })(batch, context), (error: Error) => {
    assert.match(error.message, /429/);
    assert.match(error.message, /rate limited/);
    assert.ok(!error.message.includes("sk-secret"));
    return true;
  });
});

test("unparseable JSON in the reply throws a clear error", async () => {
  const { fetch } = fakeFetch(ok("sorry, I cannot do that"));
  await assert.rejects(haikuClassifier({ fetch, apiKey: "k" })(batch, context), /not valid JSON/i);
});
