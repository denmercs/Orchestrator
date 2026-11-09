import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { askUnavailable, openAiAsk, readAskConfig, type AskConfig } from "./ask";
import { MAX_TOKENS } from "./corrections";

const config: AskConfig = { url: "https://api.x.ai/v1/", model: "grok-4-fast", keyEnv: "XAI_API_KEY", inputUsdPerMTok: 2, outputUsdPerMTok: 10 };

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function askFile(content: unknown) {
  const file = join(mkdtempSync(join(tmpdir(), "ask-")), "ask.json");
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

test("openAiAsk posts one chat completion with the key from its env var and prices the usage", async () => {
  const { fetchFn, calls } = fakeFetch(200, { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } });
  const reply = await openAiAsk(config, { XAI_API_KEY: "k" }, fetchFn)("SYSTEM", "PROMPT");
  assert.deepEqual(reply, { text: "ok", costUsd: (1000 * 2 + 100 * 10) / 1_000_000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.x.ai/v1/chat/completions");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer k");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.model, "grok-4-fast");
  assert.equal(body.max_tokens, MAX_TOKENS);
  assert.deepEqual(body.messages, [
    { role: "system", content: "SYSTEM" },
    { role: "user", content: "PROMPT" },
  ]);
});

test("openAiAsk without a keyEnv sends no authorization and, unpriced, reports no cost", async () => {
  const { fetchFn, calls } = fakeFetch(200, { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
  const reply = await openAiAsk({ url: "http://localhost:11434/v1", model: "llama3" }, {}, fetchFn)("S", "P");
  assert.deepEqual(reply, { text: "ok", costUsd: 0 });
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, undefined);
});

test("openAiAsk refuses before calling when the key's env var is unset", async () => {
  const { fetchFn, calls } = fakeFetch(200, {});
  await assert.rejects(openAiAsk(config, {}, fetchFn)("S", "P"), /XAI_API_KEY is not set/);
  assert.equal(calls.length, 0);
});

test("openAiAsk turns an error status or non-JSON body into an error", async () => {
  await assert.rejects(openAiAsk(config, { XAI_API_KEY: "k" }, fakeFetch(401, "bad key").fetchFn)("S", "P"), /answered 401: bad key/);
  await assert.rejects(openAiAsk(config, { XAI_API_KEY: "k" }, fakeFetch(200, "<html>").fetchFn)("S", "P"), /not JSON/);
});

test("readAskConfig: no file is null, a valid file parses, a broken one throws", () => {
  assert.equal(readAskConfig(join(tmpdir(), "no-such-dir", "ask.json")), null);
  assert.deepEqual(readAskConfig(askFile(config)), config);
  assert.throws(() => readAskConfig(askFile({ url: "not a url", model: "" })), /url|model/);
});

test("askUnavailable: Claude sign-in only matters without an ask.json", async () => {
  const none = join(tmpdir(), "no-such-dir", "ask.json");
  assert.equal(await askUnavailable(none, async () => true), null);
  assert.match((await askUnavailable(none, async () => false)) ?? "", /Claude Code is not signed in/);
  const file = askFile(config);
  assert.equal(await askUnavailable(file, async () => false, { XAI_API_KEY: "k" }), null);
  assert.match((await askUnavailable(file, async () => true, {})) ?? "", /XAI_API_KEY is not set/);
  assert.match((await askUnavailable(askFile("{"), async () => true)) ?? "", /JSON/);
});
