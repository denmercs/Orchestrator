import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderEvent, ProviderInput, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { createJarvisConnection, createJarvisProvider, JARVIS_ACTIVE_MS, promptText, routerIdOf, speak, spokenText } from "./jarvis-provider";
import type { RouteResult } from "./jarvis-router";

const PASEO = { type: "http" as const, url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer t" } };
const SPOKEN = "<spoken-input>\nrun the tests\n</spoken-input>\n<instruction>Reply with the speak tool.</instruction>";

const prompt = (text: string): ProviderPrompt => ({ clientMessageId: "m1", delivery: "auto", input: { type: "message", content: [{ type: "text", text }] } });

type Call = { url: string; headers: Record<string, string>; body: { method: string; params: { name: string; arguments: { text: string } } } };

function fakeFetch(reply: { status?: number; type?: string; body: string }) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    return new Response(reply.body, { status: reply.status ?? 200, headers: { "content-type": reply.type ?? "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const OK_JSON = JSON.stringify({ jsonrpc: "2.0", id: "1", result: { content: [] } });

test("spokenText reads what voice mode heard; typed text is not spoken", () => {
  assert.equal(spokenText(SPOKEN), "run the tests");
  assert.equal(spokenText("run the tests"), null);
  assert.equal(promptText(prompt("hi")), "hi");
  assert.equal(promptText({ ...prompt(""), input: { type: "command", name: "compact", arguments: "" } }), "/compact");
});

test("routerIdOf reads only our handle", () => {
  assert.equal(routerIdOf({ data: { routerId: "r1" } }), "r1");
  assert.equal(routerIdOf({ data: { sessionId: "x" } }), null);
  assert.equal(routerIdOf({ data: "r1" }), null);
  assert.equal(routerIdOf(undefined), null);
});

test("speak POSTs one JSON-RPC tools/call with the bearer header and accepts a JSON reply", async () => {
  const { impl, calls } = fakeFetch({ body: OK_JSON });
  await speak(PASEO, "Sent to docs.", impl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, PASEO.url);
  assert.equal(calls[0].headers.Authorization, "Bearer t");
  assert.equal(calls[0].headers.Accept, "application/json, text/event-stream");
  assert.equal(calls[0].body.method, "tools/call");
  assert.deepEqual(calls[0].body.params, { name: "speak", arguments: { text: "Sent to docs." } });
});

test("speak reads an SSE reply, and throws on tool errors, HTTP errors and a missing server", async () => {
  const sse = fakeFetch({ type: "text/event-stream", body: `event: message\ndata: ${OK_JSON}\n\n` });
  await speak(PASEO, "hi", sse.impl);
  const toolError = fakeFetch({ type: "text/event-stream", body: `data: ${JSON.stringify({ result: { isError: true } })}\n\n` });
  await assert.rejects(speak(PASEO, "hi", toolError.impl), /voice mode/);
  const rpcError = fakeFetch({ body: JSON.stringify({ error: { message: "Unknown tool: speak" } }) });
  await assert.rejects(speak(PASEO, "hi", rpcError.impl), /Unknown tool/);
  await assert.rejects(speak(PASEO, "hi", fakeFetch({ status: 401, body: "no" }).impl), /HTTP 401/);
  await assert.rejects(speak(undefined, "hi"), /no HTTP paseo MCP server/);
  await assert.rejects(speak({ type: "stdio", command: "paseo" }, "hi"), /no HTTP/);
});

function connect(result: RouteResult, fetchReply = OK_JSON, phoneAudio?: () => boolean, localSpeak?: (text: string) => Promise<boolean>) {
  const routed: [string, string][] = [];
  const owed: [string, string[]][] = [];
  const ended: string[] = [];
  const { impl, calls } = fakeFetch({ body: fetchReply });
  const connection = createJarvisConnection({
    route: async (routerId, text) => {
      routed.push([routerId, text]);
      return result;
    },
    owe: (routerId, lines) => void owed.push([routerId, lines]),
    playbackEnded: (routerId) => void ended.push(routerId),
    phoneAudio,
    fetch: impl,
    localSpeak,
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  return { connection, events, routed, calls, owed, ended };
}

const open = (persistence?: { version: number; data: Record<string, string> }): ProviderInput => ({
  type: "session.open",
  requestId: "q1",
  sessionId: "p1",
  config: { cwd: "/repo", env: {}, mcpServers: { paseo: PASEO }, settings: {}, persist: true },
  persistence,
  history: "skip",
});

const settle = async (events: ProviderEvent[], done: (e: ProviderEvent) => boolean) => {
  for (let i = 0; i < 50 && !events.some(done); i++) await new Promise((resolve) => setImmediate(resolve));
};

test("session.opened declares persistence with a router id, and a reopen keeps that id", async () => {
  const { connection, events } = connect({ spoken: [], note: null });
  await connection.send(open());
  await settle(events, (e) => e.type === "session.ready");
  const opened = events.find((e) => e.type === "session.opened");
  assert.ok(opened && opened.type === "session.opened");
  assert.deepEqual(opened.capabilities, ["prompt.message", "session.persistence"]);
  assert.equal(opened.restoration, "core");
  const routerId = (opened.persistence?.data as { routerId: string }).routerId;
  assert.ok(routerId);

  const again = connect({ spoken: [], note: null });
  await again.connection.send(open({ version: 1, data: { routerId } }));
  await settle(again.events, (e) => e.type === "session.ready");
  const reopened = again.events.find((e) => e.type === "session.opened");
  assert.deepEqual(reopened && reopened.type === "session.opened" ? reopened.persistence : null, { version: 1, data: { routerId } });
});

test("a spoken turn: prompt_result, started, the reply in the chat, speak, completed", async () => {
  const { connection, events, routed, calls } = connect({ spoken: ["Sent to docs."], note: null });
  await connection.send(open({ version: 1, data: { routerId: "r1" } }));
  await connection.send({ type: "session.prompt", sessionId: "p1", prompt: prompt(SPOKEN) });
  await settle(events, (e) => e.type === "session.turn" && e.state === "completed");
  const turn = events.filter((e) => ["session.prompt_result", "session.turn", "timeline.item"].includes(e.type));
  assert.deepEqual(
    turn.map((e) => (e.type === "session.turn" ? `turn:${e.state}` : e.type)),
    ["session.prompt_result", "turn:started", "timeline.item", "turn:completed"],
  );
  const result = turn[0];
  assert.ok(result.type === "session.prompt_result" && result.result.type === "turn");
  const item = turn[2];
  assert.ok(item.type === "timeline.item");
  assert.deepEqual(item.item, { id: `${result.result.turnId}-reply`, type: "assistant_message", text: "Sent to docs." });
  assert.deepEqual(routed, [["r1", "run the tests"]]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.params.arguments.text, "Sent to docs.");
});

test("a warm local voice takes the line and Paseo's speak is not called", async () => {
  const spoken: string[] = [];
  const { connection, events, calls } = connect({ spoken: ["Sent to docs."], note: null }, OK_JSON, undefined, async (text) => {
    spoken.push(text);
    return true;
  });
  await connection.send(open());
  await connection.send({ type: "session.prompt", sessionId: "p1", prompt: prompt(SPOKEN) });
  await settle(events, (e) => e.type === "session.turn" && e.state === "completed");
  assert.deepEqual(spoken, ["Sent to docs."]);
  assert.equal(calls.length, 0);
});

test("a cold or failing local voice falls back to Paseo's speak", async () => {
  for (const localSpeak of [async () => false, async () => Promise.reject(new Error("boom"))]) {
    const { connection, events, calls } = connect({ spoken: ["Sent to docs."], note: null }, OK_JSON, undefined, localSpeak);
    await connection.send(open());
    await connection.send({ type: "session.prompt", sessionId: "p1", prompt: prompt(SPOKEN) });
    await settle(events, (e) => e.type === "session.turn" && e.state === "completed");
    assert.equal(calls.length, 1);
  }
});

test("a typed turn is routed the same but answered in the chat only", async () => {
  const { connection, events, routed, calls } = connect({ spoken: ["Sent to docs."], note: null });
  await connection.send(open());
  await connection.send({ type: "session.prompt", sessionId: "p1", prompt: prompt("run the tests") });
  await settle(events, (e) => e.type === "session.turn" && e.state === "completed");
  assert.equal(routed[0][1], "run the tests");
  assert.equal(calls.length, 0);
  assert.ok(events.some((e) => e.type === "timeline.item"));
});

test("a turn with nothing to say shows the note and does not speak", async () => {
  const { connection, events, calls } = connect({ spoken: [], note: "Nothing sent." });
  await connection.send(open());
  await connection.send({ type: "session.prompt", sessionId: "p1", prompt: prompt(SPOKEN) });
  await settle(events, (e) => e.type === "session.turn" && e.state === "completed");
  const item = events.find((e) => e.type === "timeline.item");
  assert.ok(item && item.type === "timeline.item" && item.item.type === "assistant_message" && item.item.text === "Nothing sent.");
  assert.equal(calls.length, 0);
});

test("a speak that fails still completes the turn", async () => {
  const { connection, events } = connect({ spoken: ["Sent to docs."], note: null }, JSON.stringify({ error: { message: "Unknown tool" } }));
  await connection.send(open());
  await connection.send({ type: "session.prompt", sessionId: "p1", prompt: prompt(SPOKEN) });
  await settle(events, (e) => e.type === "session.turn" && e.state !== "started");
  assert.ok(events.some((e) => e.type === "session.turn" && e.state === "completed"));
});

test("close and interrupt complete their requests", async () => {
  const { connection, events } = connect({ spoken: [], note: null });
  await connection.send(open());
  await connection.send({ type: "session.interrupt", requestId: "q2", sessionId: "p1" });
  await connection.send({ type: "session.close", requestId: "q3", sessionId: "p1" });
  await settle(events, (e) => e.type === "session.closed");
  const completed = events.filter((e) => e.type === "request.completed").map((e) => (e.type === "request.completed" ? e.requestId : ""));
  assert.deepEqual(completed, ["q2", "q3"]);
});

test("the provider registers as Jarvis with one model", async () => {
  const provider = createJarvisProvider({ route: async () => ({ spoken: [], note: null }) });
  assert.equal(provider.id, "jarvis");
  assert.equal(provider.label, "Jarvis");
  assert.equal(provider.description, "Talk to your sessions hands-free with Paseo voice mode.");
  const connection = await provider.connect({ versions: [1], capabilities: [] });
  const events: ProviderEvent[] = [];
  connection.onEvent((e) => events.push(e));
  await connection.send({ type: "catalog", requestId: "q1" });
  await settle(events, (e) => e.type === "catalog");
  const catalog = events[0];
  assert.ok(catalog.type === "catalog");
  assert.deepEqual(catalog.catalog.models.map((m) => m.id), ["router"]);
});

test("a new prompt while a turn is open completes the earlier turn first", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const connection = createJarvisConnection({
    route: async (_id, text) => {
      if (text === "first") await gate;
      return { spoken: [`heard ${text}`], note: null };
    },
    fetch: fakeFetch({ body: OK_JSON }).impl,
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((e) => events.push(e));
  await connection.send(open());
  await connection.send({ type: "session.prompt", sessionId: "p1", prompt: prompt("first") });
  await settle(events, (e) => e.type === "session.turn" && e.state === "started");
  await connection.send({ type: "session.prompt", sessionId: "p1", prompt: { ...prompt("second"), clientMessageId: "m2" } });
  const turns = () => events.filter((e) => e.type === "session.prompt_result").map((e) => (e.type === "session.prompt_result" && e.result.type === "turn" ? e.result.turnId : ""));
  await settle(events, () => events.filter((e) => e.type === "session.turn" && e.state === "completed").length === 2);
  release();
  await settle(events, () => false);
  const [first, second] = turns();
  const states = (id: string) => events.filter((e) => e.type === "session.turn" && e.turnId === id).map((e) => (e.type === "session.turn" ? e.state : ""));
  assert.deepEqual(states(first), ["started", "completed"]);
  assert.deepEqual(states(second), ["started", "completed"]);
  // The earlier turn, already closed, adds nothing to the chat when its route finishes.
  const items = events.filter((e) => e.type === "timeline.item").map((e) => (e.type === "timeline.item" && e.item.type === "assistant_message" ? e.item.text : ""));
  assert.deepEqual(items, ["heard second"]);
});

test("interrupt aborts the open turn's route and cancels the turn", async () => {
  let signal: AbortSignal | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const connection = createJarvisConnection({
    route: async (_id, _text, s) => {
      signal = s;
      await gate;
      return { spoken: s?.aborted ? [] : ["Sent to docs."], note: s?.aborted ? "Stopped before sending." : null };
    },
    fetch: fakeFetch({ body: OK_JSON }).impl,
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((e) => events.push(e));
  await connection.send(open());
  await connection.send({ type: "session.prompt", sessionId: "p1", prompt: prompt(SPOKEN) });
  await settle(events, (e) => e.type === "session.turn" && e.state === "started");
  await connection.send({ type: "session.interrupt", requestId: "q9", sessionId: "p1" });
  await settle(events, (e) => e.type === "request.completed");
  assert.equal(signal?.aborted, true);
  release();
  await settle(events, () => false);
  const states = events.filter((e) => e.type === "session.turn").map((e) => (e.type === "session.turn" ? e.state : ""));
  assert.deepEqual(states, ["started", "canceled"]);
  assert.equal(events.filter((e) => e.type === "timeline.item").length, 0);
});

test("Jarvis is active after a prompt, until ten minutes idle", async () => {
  const { connection, events } = connect({ spoken: ["ok"], note: null });
  const jarvis = connection as typeof connection & { isActive(now: number): boolean };
  await jarvis.send(open());
  assert.equal(jarvis.isActive(Date.now()), false);
  await jarvis.send({ type: "session.prompt", sessionId: "p1", prompt: prompt(SPOKEN) });
  await settle(events, (e) => e.type === "session.turn" && e.state === "completed");
  const now = Date.now();
  assert.equal(JARVIS_ACTIVE_MS, 10 * 60 * 1000);
  assert.equal(jarvis.isActive(now), true);
  assert.equal(jarvis.isActive(now + JARVIS_ACTIVE_MS - 1000), true);
  assert.equal(jarvis.isActive(now + JARVIS_ACTIVE_MS + 1000), false);
});

test("Jarvis is not active without a paseo MCP server, or once the session is closed", async () => {
  const bare = connect({ spoken: [], note: null });
  const noVoice = bare.connection as typeof bare.connection & { isActive(now: number): boolean };
  const withoutPaseo = open();
  if (withoutPaseo.type === "session.open") withoutPaseo.config = { ...withoutPaseo.config, mcpServers: {} };
  await noVoice.send(withoutPaseo);
  await noVoice.send({ type: "session.prompt", sessionId: "p1", prompt: prompt("hello") });
  await settle(bare.events, (e) => e.type === "session.turn" && e.state === "completed");
  assert.equal(noVoice.isActive(Date.now()), false);

  const { connection, events } = connect({ spoken: [], note: null });
  const jarvis = connection as typeof connection & { isActive(now: number): boolean };
  await jarvis.send(open());
  await jarvis.send({ type: "session.prompt", sessionId: "p1", prompt: prompt("hello") });
  await settle(events, (e) => e.type === "session.turn" && e.state === "completed");
  assert.equal(jarvis.isActive(Date.now()), true);
  await jarvis.send({ type: "session.close", requestId: "q3", sessionId: "p1" });
  assert.equal(jarvis.isActive(Date.now()), false);
});

test("with phoneAudio off, say() speaks the lines out of turn, stamps activity and ends playback", async () => {
  const { connection, calls, ended, owed } = connect({ spoken: [], note: null });
  await connection.send(open({ version: 1, data: { routerId: "r1" } }));
  assert.equal(connection.isActive(Date.now()), false);
  await connection.say("r1", ["api-refactor: All done.", "Docs finished."]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.params.arguments.text, "api-refactor: All done. Docs finished.");
  assert.deepEqual(ended, ["r1"]);
  assert.deepEqual(owed, []);
  assert.equal(connection.isActive(Date.now()), true);
});

test("a line that cannot be spoken out of turn is owed to the next words, and playback still ends", async () => {
  const { connection, calls, ended, owed } = connect({ spoken: [], note: null }, JSON.stringify({ error: { message: "Unknown tool" } }));
  await connection.send(open({ version: 1, data: { routerId: "r1" } }));
  await connection.say("r1", ["Docs finished."]);
  assert.equal(calls.length, 1);
  assert.deepEqual(owed, [["r1", ["Docs finished."]]]);
  assert.deepEqual(ended, ["r1"]);
  // No open session for that router: nothing to speak through, so the line is owed.
  await connection.say("nope", ["Hello."]);
  assert.equal(calls.length, 1);
  assert.deepEqual(owed[1], ["nope", ["Hello."]]);
});

test("say() waits for an open turn to end before speaking", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { impl, calls } = fakeFetch({ body: OK_JSON });
  const connection = createJarvisConnection({
    route: async () => {
      await gate;
      return { spoken: ["Sent to docs."], note: null };
    },
    fetch: impl,
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((e) => events.push(e));
  await connection.send(open({ version: 1, data: { routerId: "r1" } }));
  await connection.send({ type: "session.prompt", sessionId: "p1", prompt: prompt(SPOKEN) });
  await settle(events, (e) => e.type === "session.turn" && e.state === "started");
  let said = false;
  const saying = connection.say("r1", ["Docs finished."]).then(() => (said = true));
  await settle(events, () => false);
  assert.equal(calls.length, 0);
  assert.equal(said, false);
  release();
  await saying;
  assert.deepEqual(calls.map((c) => c.body.params.arguments.text), ["Sent to docs.", "Docs finished."]);
  assert.ok(events.some((e) => e.type === "session.turn" && e.state === "completed"));
});

test("playbackEnded follows a turn's own speak too", async () => {
  const { connection, events, ended } = connect({ spoken: ["Sent to docs."], note: null });
  await connection.send(open({ version: 1, data: { routerId: "r1" } }));
  await connection.send({ type: "session.prompt", sessionId: "p1", prompt: prompt(SPOKEN) });
  await settle(events, (e) => e.type === "session.turn" && e.state === "completed");
  assert.deepEqual(ended, ["r1"]);
});

const voiceLines = (events: ProviderEvent[]) =>
  events.flatMap((e) => (e.type === "timeline.item" && e.item.type === "plugin" && e.item.kind === "voice-line" ? [e.item] : []));

test("with phoneAudio on, say() emits one voice-line plugin item per line, with unique ids, and does not speak", async () => {
  const { connection, events, calls, ended, owed } = connect({ spoken: [], note: null }, OK_JSON, () => true);
  await connection.send(open({ version: 1, data: { routerId: "r1" } }));
  await connection.say("r1", ["api-refactor: All done.", "Docs finished."]);
  await connection.say("r1", ["Docs finished."]);
  const items = voiceLines(events);
  assert.equal(calls.length, 0);
  assert.deepEqual(
    items.map((i) => [i.pluginId, i.version, (i.data as { text: string }).text]),
    [
      ["orchestrator", 1, "api-refactor: All done."],
      ["orchestrator", 1, "Docs finished."],
      ["orchestrator", 1, "Docs finished."],
    ],
  );
  const ids = items.map((i) => (i.data as { lineId: string }).lineId);
  assert.ok(ids.every(Boolean));
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(owed, []);
  assert.deepEqual(ended, ["r1", "r1"]);
});

test("with phoneAudio on, a spoken turn shows the reply in the chat and sends a voice-line instead of speak", async () => {
  const { connection, events, calls } = connect({ spoken: ["Sent to docs."], note: null }, OK_JSON, () => true);
  await connection.send(open({ version: 1, data: { routerId: "r1" } }));
  await connection.send({ type: "session.prompt", sessionId: "p1", prompt: prompt(SPOKEN) });
  await settle(events, (e) => e.type === "session.turn" && e.state === "completed");
  assert.equal(calls.length, 0);
  const chat = events.flatMap((e) => (e.type === "timeline.item" && e.item.type === "assistant_message" ? [e.item.text] : []));
  assert.deepEqual(chat, ["Sent to docs."]);
  const items = voiceLines(events);
  assert.equal(items.length, 1);
  assert.equal((items[0].data as { text: string }).text, "Sent to docs.");
  assert.ok((items[0].data as { lineId: string }).lineId);
});

test("with phone audio on the line goes to the phone, not to the Mac's voice", async () => {
  const spoken: string[] = [];
  const { connection, events, calls } = connect({ spoken: ["Sent to docs."], note: null }, OK_JSON, () => true, async (text) => (spoken.push(text), true));
  await connection.send(open());
  await connection.send({ type: "session.prompt", sessionId: "p1", prompt: prompt(SPOKEN) });
  await settle(events, (e) => e.type === "session.turn" && e.state === "completed");
  assert.deepEqual(spoken, []);
  assert.equal(calls.length, 0);
});
