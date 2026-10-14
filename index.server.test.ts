import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "./index.server";
import { speakRepliesSet, speakRepliesState } from "./shared/speak-replies";
import { startMemoryReplay } from "./shared/replay-rpc";
import { voiceEvents, voiceHelperStart, voiceHelperStop, voiceHelperSwitch, voiceInterpret, voiceSpeak, voiceStatus, voiceTarget } from "./shared/voice-rpc";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// No test starts the real Speaker: its workers spawn `uv`.
const quietSpeaker = (readClip: () => string | undefined) => {
  const worker = { ready: () => false, render: async () => "" };
  return { chatterbox: worker, kokoro: worker, readClip, now: Date.now, sleep: async () => undefined, start: () => undefined, stop: () => undefined };
};

function registeredSettingIds(): string[] {
  const ids: string[] = [];
  const noop = () => undefined;
  const server = new Proxy({} as PluginServerContext, {
    get: (_target, key) =>
      key === "registerSettings"
        ? (definition: { id: string }) => {
            ids.push(definition.id);
            return new Proxy({}, { get: (_t, k) => (k === "read" ? async () => ({ status: "loading" }) : noop) });
          }
        : noop,
  });
  contribute(server, { speakerPorts: quietSpeaker });
  return ids;
}

test("registers each setting once, since the host refuses a duplicate id", () => {
  const ids = registeredSettingIds();
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(duplicates, [], `registered twice: ${duplicates.join(", ")}`);
});

test("registers the dashboard tab setting on the host", () => {
  const ids = registeredSettingIds();
  assert.ok(ids.includes("dashboard"), `registered: ${ids.join(", ")}`);
});

test("registers the budget setting on the host", () => {
  const ids = registeredSettingIds();
  assert.ok(ids.includes("budget"), `registered: ${ids.join(", ")}`);
});

test("registers the plan usage RPC, which reads the daemon's provider usage", async () => {
  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>();
  const noop = () => undefined;
  const server = new Proxy({} as PluginServerContext, {
    get: (_target, key) => {
      if (key === "handle") {
        return (rpc: { name: string }, handler: (input: unknown, context: unknown) => unknown) => {
          handlers.set(rpc.name, handler);
        };
      }
      if (key === "registerSettings") {
        return () => new Proxy({}, { get: (_t, k) => (k === "read" ? async () => ({ status: "loading" }) : noop) });
      }
      return noop;
    },
  });
  contribute(server, { speakerPorts: quietSpeaker });
  const handler = handlers.get("orchestration.usage.plan");
  assert.ok(handler, "orchestration.usage.plan is handled");
  const paseo = { providers: { listUsage: async () => ({ fetchedAt: "", providers: [] }) } };
  assert.deepEqual(await handler({}, { paseo }), { providers: [], error: null });
});

function usageSourceIds(host: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const noop = () => undefined;
  const server = new Proxy({} as PluginServerContext, {
    get: (_target, key) => {
      if (key === "registerUsageSource") {
        return "registerUsageSource" in host ? (source: { id: string }) => ids.push(source.id) : undefined;
      }
      if (key === "registerSettings") {
        return () => new Proxy({}, { get: (_t, k) => (k === "read" ? async () => ({ status: "loading" }) : noop) });
      }
      return noop;
    },
  });
  contribute(server, { speakerPorts: quietSpeaker });
  return ids;
}

test("registers the Kiro usage source when the host has registerUsageSource", () => {
  assert.deepEqual(usageSourceIds({ registerUsageSource: true }), ["kiro"]);
});

test("still loads on a host without registerUsageSource", () => {
  assert.deepEqual(usageSourceIds({}), []);
});

test("registers the Jarvis provider", () => {
  const ids: string[] = [];
  const noop = () => undefined;
  const server = new Proxy({} as PluginServerContext, {
    get: (_target, key) => {
      if (key === "registerProvider") return (provider: { id: string; label: string }) => ids.push(`${provider.id}:${provider.label}`);
      if (key === "registerSettings") {
        return () => new Proxy({}, { get: (_t, k) => (k === "read" ? async () => ({ status: "loading" }) : noop) });
      }
      return noop;
    },
  });
  contribute(server, { speakerPorts: quietSpeaker });
  assert.deepEqual(ids, ["jarvis:Jarvis"]);
});

type Fake = {
  pending: string[];
  calls: string[];
  replayed: unknown[];
};

// Set by a test that needs voice.phoneAudio on in `wired`.
let voicePhoneAudio = false;

function wired(
  pending: string[] = [],
  signedIn = true,
  replayStart?: { file: string; everyMs: number },
  loopStart?: { file: string; everyMs: number },
  voiceHelperCwd?: string,
  extra: Partial<Parameters<typeof contribute>[1]> = {},
) {
  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>();
  const listeners = new Map<string, (event: unknown, context: unknown) => unknown>();
  const providers: { connect(): Promise<unknown> }[] = [];
  const noop = () => undefined;
  const fake: Fake = { pending, calls: [], replayed: [] };
  const runner = {
    pendingAgents: () => fake.pending,
    onTurnEnded: async (e: { agentId: string }) => void fake.calls.push(`turn:${e.agentId}`),
    onAgentFailed: async (e: { agentId: string; error?: string }) => void fake.calls.push(`failed:${e.agentId}:${e.error}`),
    runRound: async () => [],
    replay: async (corpus: unknown, opts: unknown) => {
      fake.replayed.push({ corpus, opts });
      return { rounds: 0, started: 0, stoppedByCap: false };
    },
  };
  const server = new Proxy({} as PluginServerContext, {
    get: (_target, key) => {
      if (key === "handle") return (rpc: { name: string }, h: never) => void handlers.set(rpc.name, h);
      if (key === "on") return (name: string, h: never) => (listeners.set(name, h), noop);
      if (key === "registerProvider") return (provider: { connect(): Promise<unknown> }) => void providers.push(provider);
      if (key === "registerSettings") {
        return (definition: { id: string }) => {
          const state = definition.id === "voice" && voicePhoneAudio ? { status: "ready", values: { referenceClip: "", phoneAudio: true } } : { status: "loading" };
          return new Proxy({}, { get: (_t, k) => (k === "read" ? async () => state : () => noop) });
        };
      }
      // Anything else hands back an unsubscribe, so the cleanup contribute returns can run.
      return () => noop;
    },
  });
  const stop = contribute(server, { replay: runner, signedIn: async () => signedIn, replayStart, loopStart, voiceHelperCwd, speakerPorts: quietSpeaker, ...extra });
  return { handlers, listeners, providers, fake, stop };
}

function repoWithCorpus(rows: object[] | null): string {
  const root = mkdtempSync(join(tmpdir(), "replay-root-"));
  if (rows) {
    mkdirSync(join(root, ".harness", "replay"), { recursive: true });
    writeFileSync(join(root, ".harness", "replay", "corpus.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  return root;
}

const row = (story: string, kind: "failed" | "control") => ({
  initiative: "i", story, title: story, body: "", round: 1, kind, commit: "c", base: "b", asOf: "2026-01-01T00:00:00Z", findings: [], plan: "", cycles: "",
});

test("handles startMemoryReplay: reads the corpus, passes the cap and starts the replay", async () => {
  const { handlers, fake } = wired();
  const handler = handlers.get(startMemoryReplay.name);
  assert.ok(handler, "startMemoryReplay is handled");
  const root = repoWithCorpus([row("S1", "failed"), row("S2", "control"), row("S3", "control")]);
  const result = (await handler({ root, costCap: 5, controls: 1 }, { paseo: {} })) as { rounds: number };
  assert.equal(result.rounds, 2);
  const call = fake.replayed[0] as { corpus: { story: string }[]; opts: { costCap: number; root: string } };
  assert.deepEqual(call.corpus.map((r) => r.story), ["S1", "S2"]);
  assert.equal(call.opts.costCap, 5);
  assert.equal(call.opts.root, root);
});

test("startMemoryReplay takes the cap from the corpus's cost-cap file, and an explicit costCap wins", async () => {
  const { handlers, fake } = wired();
  const handler = handlers.get(startMemoryReplay.name);
  assert.ok(handler);
  const root = repoWithCorpus([row("S1", "failed")]);
  writeFileSync(join(root, ".harness", "replay", "cost-cap"), "50\n");
  const fromFile = (await handler({ root }, { paseo: {} })) as { costCap: number };
  assert.equal(fromFile.costCap, 50);
  assert.equal((fake.replayed[0] as { opts: { costCap: number } }).opts.costCap, 50);
  await new Promise((r) => setTimeout(r, 10));
  const explicit = (await handler({ root, costCap: 7 }, { paseo: {} })) as { costCap: number };
  assert.equal(explicit.costCap, 7);
});

test("startMemoryReplay writes to the run named in the run-name file", async () => {
  const { handlers, fake } = wired();
  const handler = handlers.get(startMemoryReplay.name);
  assert.ok(handler);
  const root = repoWithCorpus([row("S1", "failed")]);
  writeFileSync(join(root, ".harness", "replay", "run-name"), "findings-only\n");
  const result = (await handler({ root }, { paseo: {} })) as { run: string; runDir: string };
  assert.equal(result.run, "findings-only");
  assert.equal(result.runDir, join(root, ".harness", "replay", "findings-only"));
  const opts = (fake.replayed[0] as { opts: { run: string; runDir: string } }).opts;
  assert.deepEqual([opts.run, opts.runDir], ["findings-only", join(root, ".harness", "replay", "findings-only")]);
});

test("startMemoryReplay says clearly when the corpus is missing", async () => {
  const { handlers } = wired();
  const handler = handlers.get(startMemoryReplay.name);
  assert.ok(handler);
  await assert.rejects(async () => handler({ root: repoWithCorpus(null) }, { paseo: {} }), /corpus\.jsonl.*corpus\.mjs/s);
});

test("startMemoryReplay refuses to start when Claude Code is signed out", async () => {
  const { handlers, fake } = wired([], false);
  const handler = handlers.get(startMemoryReplay.name);
  assert.ok(handler);
  await assert.rejects(async () => handler({ root: repoWithCorpus([row("S1", "failed")]) }, { paseo: {} }), /not signed in/);
  assert.equal(fake.replayed.length, 0);
});

test("a memory-replay turn end reaches the runner and not the initiative loop", async () => {
  const { listeners, fake } = wired(["replay-1"]);
  const onTurn = listeners.get("agent.turn_ended");
  assert.ok(onTurn);
  let looked = 0;
  const paseo = { agents: { ref: () => (looked++, { refresh: async () => null }) } };
  const agent = (id: string) => ({ id, workspaceId: null, parentAgentId: null, provider: "claude", cwd: "/x", title: null });
  const end = (id: string, outcome: object) => onTurn({ agent: agent(id), turnId: null, outcome, timeline: [] }, { paseo });
  await end("replay-1", { kind: "completed" });
  await end("replay-1", { kind: "failed", error: { message: "boom" } });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(fake.calls, ["turn:replay-1", "failed:replay-1:boom"]);
  // Only the context watch (telemetry) looks at a replay agent; a loop agent is also looked at by the initiative loop.
  const replayLooks = looked;
  looked = 0;
  await end("other", { kind: "completed" });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(fake.calls, ["turn:replay-1", "failed:replay-1:boom"], "a stranger never reaches the runner");
  assert.ok(looked > replayLooks / 2, `the initiative loop looks at other agents (${looked} vs ${replayLooks / 2})`);
});

const until = async (done: () => boolean) => {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
};

test("a start file starts the replay with the same opts the RPC gives, once Paseo is known", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "replay-start-")), "replay-start.json");
  const { listeners, fake, stop } = wired([], true, { file, everyMs: 5 });
  try {
    const root = repoWithCorpus([row("S1", "failed"), row("S2", "control")]);
    writeFileSync(join(root, ".harness", "replay", "cost-cap"), "50\n");
    writeFileSync(join(root, ".harness", "replay", "run-name"), "findings-only\n");
    writeFileSync(join(root, ".harness", "replay", "arms"), "facts\n");
    writeFileSync(file, JSON.stringify({ root, controls: 0 }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(existsSync(file), true, "the file waits while there is no Paseo API");
    assert.equal(fake.replayed.length, 0);
    const created = listeners.get("agent.created");
    assert.ok(created);
    created({ agent: { id: "a" } }, { paseo: {} });
    await until(() => existsSync(file.replace(/\.json$/, ".result.json")));
    assert.equal(existsSync(file), false);
    const call = fake.replayed[0] as { corpus: { story: string }[]; opts: object };
    assert.deepEqual(call.corpus.map((r) => r.story), ["S1"]);
    const runDir = join(root, ".harness", "replay", "findings-only");
    assert.deepEqual(call.opts, { run: "findings-only", root, runDir, costCap: 50, arms: ["facts"] });
    const result = JSON.parse(readFileSync(file.replace(/\.json$/, ".result.json"), "utf8"));
    assert.deepEqual({ ...result, at: undefined }, { at: undefined, ok: true, run: "findings-only", rounds: 1, costCap: 50, runDir });
  } finally {
    stop();
  }
});

test("a loop start file starts the initiative loop with that input, once Paseo is known", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "loop-start-")), "initiative-loop-start.json");
  const { listeners, stop } = wired([], true, undefined, { file, everyMs: 5 });
  try {
    // An initiative that isn't there, so the loop's own check answers without touching the repo registry.
    const repo = mkdtempSync(join(tmpdir(), "loop-repo-"));
    writeFileSync(file, JSON.stringify({ repo, initiative: "nope" }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(existsSync(file), true, "the file waits while there is no Paseo API");
    const created = listeners.get("agent.created");
    assert.ok(created);
    created({ agent: { id: "a" } }, { paseo: {} });
    const result = file.replace(/\.json$/, ".result.json");
    await until(() => existsSync(result));
    assert.equal(existsSync(file), false);
    assert.deepEqual(
      { ...JSON.parse(readFileSync(result, "utf8")), at: undefined },
      { at: undefined, ok: false, error: `nope is not an initiative in ${repo}.`, started: [], reason: "" },
    );
  } finally {
    stop();
  }
});

// A fake Paseo that records every agent it is asked about; `create` hands back the helper's id.
function helperPaseo() {
  const calls: string[] = [];
  const paseo = {
    agents: {
      create: async () => (calls.push("create"), { id: "helper-1" }),
      ref: (id: string) => (
        calls.push(`ref:${id}`),
        {
          refresh: async () => (calls.push(`refresh:${id}`), null),
          archive: async () => void calls.push(`archive:${id}`),
        }
      ),
    },
  };
  return { paseo, calls };
}

const turnAgent = (id: string, cwd = "/x") => ({ id, workspaceId: null, parentAgentId: null, provider: "claude", cwd, title: null });

test("the voice helper RPCs start and stop one helper agent, and interpret falls back while it is not started", async () => {
  const cwd = join(mkdtempSync(join(tmpdir(), "voice-helper-")), "nested", "helper");
  const { handlers, stop } = wired([], true, undefined, undefined, cwd);
  const { paseo, calls } = helperPaseo();
  const start = handlers.get(voiceHelperStart.name);
  const halt = handlers.get(voiceHelperStop.name);
  const interpret = handlers.get(voiceInterpret.name);
  assert.ok(start && halt && interpret, "all three RPCs are handled");
  const input = { transcript: "hi", sessionId: "s", sessions: [{ id: "s", name: "api" }] };
  assert.deepEqual(await interpret(input, { paseo }), {
    result: { type: "send", text: "hi" },
    via: "passThrough",
    reason: "starting",
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.filter((c) => c === "create").length, 2, "the fallback warmed the helper and the reply summariser in the background");
  assert.deepEqual(await start({}, { paseo }), { ok: true });
  assert.equal(existsSync(cwd), true, "the helper's folder is made before the agent is created");
  await start({}, { paseo });
  assert.equal(calls.filter((c) => c === "create").length, 2, "start finds the warmed helper and summariser");
  assert.deepEqual(await halt({}, { paseo }), { ok: true });
  assert.ok(calls.includes("archive:helper-1"));
  stop();
});

test("the drawer's status RPC says who needs you, hit an error or is running, and leaves out other words", async () => {
  const { handlers, stop } = wired();
  const agents = [
    { id: "a1", title: "api", status: "running", provider: "claude", labels: {} },
    { id: "a2", title: "docs", status: "running", provider: "claude", labels: {}, pendingPermissions: [{}] },
    { id: "a3", title: "web", status: "error", provider: "claude", labels: {} },
    { id: "a4", title: "old", status: "closed", provider: "claude", labels: {} },
  ];
  const paseo = { agents: { ref: () => ({ refresh: async () => null }), list: async () => ({ entries: agents.map((agent) => ({ agent })) }) } };
  await handlers.get(voiceTarget.name)!({ id: "a1", name: "api" }, { paseo });
  const status = handlers.get(voiceStatus.name)!;
  assert.deepEqual(await status({ text: "Jarvis, status" }, { paseo }), { spoken: ["docs needs you. web hit an error. api is running."] });
  assert.equal(await status({ text: "run the tests" }, { paseo }), null);
  stop();
});

test("a helper agent's turn end writes only the telemetry read, and a stranger still takes the normal route", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "voice-helper-"));
  const { handlers, listeners, stop } = wired([], true, undefined, undefined, cwd);
  const { paseo, calls } = helperPaseo();
  await handlers.get(voiceHelperStart.name)!({}, { paseo });
  const onTurn = listeners.get("agent.turn_ended");
  assert.ok(onTurn);
  const end = (id: string, outcome: object) => onTurn({ agent: turnAgent(id), turnId: null, outcome, timeline: [] }, { paseo });
  calls.length = 0;
  await end("helper-1", { kind: "completed" });
  await new Promise((r) => setTimeout(r, 20));
  // The context watch reads the agent for its telemetry row; the loop, pipeline and initiative loop would look at it too.
  assert.deepEqual(calls, ["ref:helper-1", "refresh:helper-1"]);
  calls.length = 0;
  await end("other", { kind: "completed" });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(calls.length > 2, `a stranger goes the whole route (${calls.join(", ")})`);
  stop();
});

test("a helper turn end that lands after voice turns off is still telemetry only", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "voice-helper-"));
  const { handlers, listeners, stop } = wired([], true, undefined, undefined, cwd);
  const { paseo, calls } = helperPaseo();
  await handlers.get(voiceHelperStart.name)!({}, { paseo });
  await handlers.get(voiceHelperStop.name)!({}, { paseo });
  calls.length = 0;
  // A helper turn that finished as voice turned off: its turn end arrives once the helper has forgotten the id.
  await listeners.get("agent.turn_ended")!(
    { agent: turnAgent("helper-1", cwd), turnId: null, outcome: { kind: "completed" }, timeline: [] },
    { paseo },
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, ["ref:helper-1", "refresh:helper-1"]);
  stop();
});

test("disposing the plugin archives the voice helper", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "voice-helper-"));
  const { handlers, stop } = wired([], true, undefined, undefined, cwd);
  const { paseo, calls } = helperPaseo();
  await handlers.get(voiceHelperStart.name)!({}, { paseo });
  stop();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(calls.includes("archive:helper-1"));
});

// The Mac's players are fakes: `plays` are the sentences played, `kills` how often a sentence was cut off.
function speakWired(pending: string[] = [], voiceHelperCwd?: string) {
  const plays: string[] = [];
  const says: string[] = [];
  const state = { kills: 0 };
  const ready = { ready: () => true, render: async (text: string) => `audio:${text}` };
  const speakerPorts = (readClip: () => string | undefined) => ({
    chatterbox: ready,
    kokoro: ready,
    readClip,
    now: () => 0,
    sleep: () => new Promise<void>(() => undefined),
    start: () => undefined,
    stop: () => undefined,
  });
  const localPorts = (render: (input: { text: string; replyId: string }) => Promise<unknown>) => ({
    render: render as never,
    play: (audio: string) => {
      plays.push(audio);
      return { done: new Promise<void>(() => undefined), kill: () => void (state.kills += 1) };
    },
    say: (text: string) => {
      says.push(text);
      return { done: Promise.resolve(), kill: () => undefined };
    },
  });
  return { plays, says, state, ...wired(pending, true, undefined, undefined, voiceHelperCwd, { speakerPorts, localPorts }) };
}

const spokenTurn = (id: string) => ({
  agent: { id, workspaceId: null, parentAgentId: null, provider: "claude", cwd: "/x", title: null },
  turnId: null,
  outcome: { kind: "completed" },
  timeline: [{ type: "assistant_message", text: "All done." }],
});

const paseoStub = { agents: { ref: () => ({ refresh: async () => null }) } };
const tick = () => new Promise((r) => setTimeout(r, 10));

test("speak replies: a switched-on session's reply is spoken once on the Mac, and kept from the drawer", async () => {
  const { handlers, listeners, plays, stop } = speakWired();
  const paseo = paseoStub;
  await handlers.get(speakRepliesSet.name)!({ agentId: "s1", mode: "short" }, { paseo });
  assert.deepEqual(await handlers.get(speakRepliesState.name)!({}, { paseo }), { modes: { s1: "short" } });
  await listeners.get("agent.turn_ended")!(spokenTurn("s1"), { paseo });
  await listeners.get("agent.turn_ended")!(spokenTurn("s2"), { paseo });
  await tick();
  assert.deepEqual(plays, ["audio:All done."]);
  const read = (await handlers.get(voiceEvents.name)!({ after: 0 }, { paseo })) as { events: { type: string; sessionId: string }[] };
  assert.deepEqual(
    read.events.map((e) => `${e.type}:${e.sessionId}`),
    ["notice:s1", "reply:s2", "notice:s2"],
  );
  stop();
});

test("speak replies: a new turn on a switched-on session hushes the Mac's voice", async () => {
  const { handlers, listeners, plays, state, stop } = speakWired();
  const paseo = paseoStub;
  await handlers.get(speakRepliesSet.name)!({ agentId: "s1", mode: "short" }, { paseo });
  await listeners.get("agent.turn_ended")!(spokenTurn("s1"), { paseo });
  await tick();
  assert.equal(plays.length, 1);
  await listeners.get("agent.turn_started")!({ agent: spokenTurn("s1").agent, turnId: null }, { paseo });
  await listeners.get("agent.turn_started")!({ agent: spokenTurn("s2").agent, turnId: null }, { paseo });
  assert.equal(state.kills, 1);
  stop();
});

test("speak replies: a memory-replay turn end stays silent even for a switched-on session", async () => {
  const { handlers, listeners, plays, says, stop } = speakWired(["s1"]);
  const paseo = paseoStub;
  await handlers.get(speakRepliesSet.name)!({ agentId: "s1", mode: "short" }, { paseo });
  await listeners.get("agent.turn_ended")!(spokenTurn("s1"), { paseo });
  await tick();
  assert.deepEqual([plays, says], [[], []]);
  stop();
});

test("turn_ended / permission_requested reach the hub and the router; orchestration.voice.events answers with phoneActive", async () => {
  const { handlers, listeners, providers, stop } = wired();
  const spoken: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    spoken.push(JSON.parse(init.body as string).params.arguments.text);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  try {
    const events = handlers.get(voiceEvents.name);
    assert.ok(events, "orchestration.voice.events is handled");
    const { paseo } = helperPaseo();
    const agent = { id: "s1", provider: "claude", title: "api", cwd: "/x", labels: {} };
    const listing = { ...paseo, agents: { ...paseo.agents, list: async () => ({ entries: [{ agent }] }) } };
    assert.deepEqual(await events({ after: 0 }, { paseo: listing }).then((r) => (r as { phoneActive: boolean }).phoneActive), false);
    // A phone session with voice mode on (it has a paseo MCP server); its first words make its router.
    const jarvis = (await providers[0].connect()) as {
      send(input: unknown): Promise<void>;
      onEvent(listener: (e: { type: string; state?: string }) => void): void;
    };
    const seen: { type: string; state?: string }[] = [];
    jarvis.onEvent((e) => seen.push(e));
    await jarvis.send({
      type: "session.open",
      requestId: "q1",
      sessionId: "p1",
      config: { cwd: "/repo", env: {}, mcpServers: { paseo: { type: "http", url: "http://127.0.0.1:1/mcp", headers: {} } }, settings: {}, persist: true },
      persistence: { version: 1, data: { routerId: "r1" } },
      history: "skip",
    });
    await handlers.get(voiceTarget.name)!({ id: "s1", name: "api" }, { paseo: listing });
    await jarvis.send({
      type: "session.prompt",
      sessionId: "p1",
      prompt: { clientMessageId: "m1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "hello" }] } },
    });
    await until(() => seen.some((e) => e.type === "session.turn" && e.state === "completed"));
    spoken.length = 0;

    const timeline = [
      { type: "user_message", text: "go" },
      { type: "assistant_message", text: "All done." },
    ];
    listeners.get("agent.turn_ended")!({ agent, turnId: null, outcome: { kind: "completed" }, timeline }, { paseo: listing });
    listeners.get("agent.permission_requested")!({ agent }, { paseo: listing });
    await until(() => spoken.length > 0);

    const answered = (await events({ after: 0 }, { paseo: listing })) as { cursor: number; events: unknown[]; phoneActive: boolean };
    assert.equal(answered.cursor, 3);
    assert.deepEqual(answered.events, [
      { type: "reply", sessionId: "s1", text: "All done." },
      { type: "notice", kind: "finished", sessionId: "s1" },
      { type: "notice", kind: "needsYou", sessionId: "s1" },
    ]);
    assert.equal(answered.phoneActive, true);
    assert.match(spoken.join(" "), /All done\./);
  } finally {
    globalThis.fetch = realFetch;
    stop();
  }
});

// "asleep": phone audio on and the phone active, but the Voice loop was put to sleep, so the phone would not say it: the Mac must.
for (const [phoneAudio, asleep] of [[true, false], [false, false], [true, true]]) {
  test(`speak replies on the phone: voice.phoneAudio ${asleep ? "on but the loop asleep falls back to the Mac, never heard nowhere" : phoneAudio ? "on sends another session's reply to the phone as one voice-line and the Mac stays quiet" : "off keeps it on the Mac and off the hub"}`, async () => {
    voicePhoneAudio = phoneAudio;
    const { handlers, listeners, providers, plays, stop } = speakWired();
    try {
      await tick();
      const target = { id: "s1", provider: "claude", title: "api", cwd: "/x", labels: {} };
      const watched = { id: "s2", provider: "claude", title: "docs", cwd: "/x", labels: {} };
      const paseo = { agents: { ref: () => ({ refresh: async () => null }), list: async () => ({ entries: [{ agent: target }, { agent: watched }] }) } };
      const jarvis = (await providers[0].connect()) as { send(input: unknown): Promise<void>; onEvent(listener: (e: { type: string; state?: string; item?: { kind?: string; data?: { text: string } } }) => void): void };
      const seen: { type: string; state?: string; item?: { kind?: string; data?: { text: string } } }[] = [];
      jarvis.onEvent((e) => seen.push(e));
      await jarvis.send({
        type: "session.open",
        requestId: "q1",
        sessionId: "p1",
        config: { cwd: "/repo", env: {}, mcpServers: { paseo: { type: "http", url: "http://127.0.0.1:1/mcp", headers: {} } }, settings: {}, persist: true },
        persistence: { version: 1, data: { routerId: "r1" } },
        history: "skip",
      });
      await handlers.get(voiceTarget.name)!({ id: "s1", name: "api" }, { paseo });
      await jarvis.send({
        type: "session.prompt",
        sessionId: "p1",
        prompt: { clientMessageId: "m1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "hello" }] } },
      });
      await until(() => seen.some((e) => e.type === "session.turn" && e.state === "completed"));
      if (asleep) {
        await jarvis.send({
          type: "session.prompt",
          sessionId: "p1",
          prompt: { clientMessageId: "m2", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "Jarvis, ignore me" }] } },
        });
        await until(() => seen.filter((e) => e.type === "session.turn" && e.state === "completed").length >= 2);
      }
      await handlers.get(speakRepliesSet.name)!({ agentId: "s2", mode: "short" }, { paseo });
      listeners.get("agent.turn_ended")!({ ...spokenTurn("s2"), agent: watched }, { paseo });
      await tick();
      const read = (await handlers.get(voiceEvents.name)!({ after: 0 }, { paseo })) as { events: { type: string; sessionId: string; watched?: boolean }[] };
      const lineItems = seen.filter((e) => e.item?.kind === "voice-line").map((e) => e.item?.data?.text);
      if (asleep) {
        assert.deepEqual(lineItems, [], "the phone says nothing");
        assert.deepEqual(plays, ["audio:All done."], "so the Mac says it");
        assert.deepEqual(read.events.map((e) => `${e.type}:${e.sessionId}`), ["notice:s2"]);
      } else if (phoneAudio) {
        assert.deepEqual(read.events, [{ type: "reply", sessionId: "s2", text: "All done.", watched: true }]);
        assert.deepEqual(lineItems, ["docs: All done."]);
        assert.deepEqual(plays, [], "the Mac says nothing");
      } else {
        assert.deepEqual(read.events.map((e) => `${e.type}:${e.sessionId}`), ["notice:s2"]);
        assert.deepEqual(lineItems, []);
        assert.deepEqual(plays, ["audio:All done."]);
      }
    } finally {
      voicePhoneAudio = false;
      stop();
    }
  });
}

type SpeakerFake = { started: number; stopped: number; rendered: { text: string; clip?: string }[] };

function withSpeaker(clip: string, defaultReferenceClip = "/no/such/reference.wav") {
  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>();
  const settingIds: string[] = [];
  const noop = () => undefined;
  const fake: SpeakerFake = { started: 0, stopped: 0, rendered: [] };
  const worker = (engine: string) => ({
    ready: () => true,
    render: async (text: string, c?: string) => (fake.rendered.push({ text, clip: c }), engine),
  });
  const ports = (readClip: () => string | undefined) => ({
    chatterbox: worker("chatterbox-audio"),
    kokoro: worker("kokoro-audio"),
    readClip,
    now: () => 0,
    sleep: () => new Promise<void>(() => undefined),
    start: () => void (fake.started += 1),
    stop: () => void (fake.stopped += 1),
  });
  const server = new Proxy({} as PluginServerContext, {
    get: (_target, key) => {
      if (key === "handle") return (rpc: { name: string }, h: never) => void handlers.set(rpc.name, h);
      if (key === "registerSettings") {
        return (definition: { id: string }) => {
          settingIds.push(definition.id);
          const state = definition.id === "voice" ? { status: "ready", values: { referenceClip: clip, phoneAudio: false } } : { status: "loading" };
          return new Proxy({}, { get: (_t, k) => (k === "read" ? async () => state : () => noop) });
        };
      }
      return () => noop;
    },
  });
  const stop = contribute(server, { speakerPorts: ports, defaultReferenceClip });
  return { handlers, settingIds, fake, stop };
}

test("registers the voice settings (reference clip and phone audio)", () => {
  assert.ok(withSpeaker("").settingIds.includes("voice"));
});

test("starts the Speaker's workers when the plugin starts", () => {
  assert.equal(withSpeaker("").fake.started, 1);
});

test("orchestration.voice.speak renders through the Speaker with the reference clip from the voice setting", async () => {
  const { handlers, fake } = withSpeaker("/me.wav");
  await new Promise((r) => setTimeout(r, 10));
  const speak = handlers.get(voiceSpeak.name);
  assert.ok(speak, "orchestration.voice.speak is handled");
  assert.deepEqual(await speak({ text: "Hello.", replyId: "r1" }, {}), { audio: "chatterbox-audio", engine: "chatterbox" });
  assert.deepEqual(fake.rendered, [{ text: "Hello.", clip: "/me.wav" }]);
});

test("an empty reference clip means Kokoro only", async () => {
  const { handlers, fake } = withSpeaker("");
  await new Promise((r) => setTimeout(r, 10));
  const answer = await handlers.get(voiceSpeak.name)!({ text: "Hello.", replyId: "r1" }, {});
  assert.deepEqual(answer, { audio: "kokoro-audio", engine: "kokoro" });
  assert.equal(fake.rendered[0].clip, undefined);
});

test("an empty reference clip setting falls back to the default clip when that file exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clip-"));
  const clip = join(dir, "reference.wav");
  writeFileSync(clip, "wav");
  const { handlers, fake } = withSpeaker("", clip);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(await handlers.get(voiceSpeak.name)!({ text: "Hello.", replyId: "r1" }, {}), { audio: "chatterbox-audio", engine: "chatterbox" });
  assert.equal(fake.rendered[0].clip, clip);
});

test("a clip set in the voice setting wins over the default clip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clip-"));
  const clip = join(dir, "reference.wav");
  writeFileSync(clip, "wav");
  const { handlers, fake } = withSpeaker("/mine.wav", clip);
  await new Promise((r) => setTimeout(r, 10));
  await handlers.get(voiceSpeak.name)!({ text: "Hello.", replyId: "r1" }, {});
  assert.equal(fake.rendered[0].clip, "/mine.wav");
});

test("stops the Speaker's workers on cleanup", () => {
  const { fake, stop } = withSpeaker("");
  assert.equal(fake.stopped, 0);
  stop();
  assert.equal(fake.stopped, 1);
});

// Wires contribute with a `before` capture and a voice setting that reads as `voiceProfile`.
function createHook(voiceProfile: string) {
  let hook: ((input: unknown, context: unknown) => Promise<unknown>) | undefined;
  const noop = () => undefined;
  const server = new Proxy({} as PluginServerContext, {
    get: (_target, key) => {
      if (key === "before") {
        return (name: string, h: never) => {
          if (name === "agent.create") hook = h;
          return noop;
        };
      }
      if (key === "registerSettings") {
        return (definition: { id: string }) =>
          new Proxy(
            {},
            {
              get: (_t, k) =>
                k === "read"
                  ? async () =>
                      definition.id === "voice"
                        ? { status: "ready", values: { profile: voiceProfile } }
                        : { status: "loading" }
                  : () => noop,
            },
          );
      }
      return () => noop;
    },
  });
  contribute(server, { speakerPorts: quietSpeaker });
  assert.ok(hook, "agent.create has a before hook");
  return hook;
}

const sonnetProfiles = {
  config: {
    daemon: {
      agentProfiles: [
        { id: "opus", name: "Claude | Opus", provider: "claude", model: "claude-opus-4" },
        { id: "sonnet", name: "Claude | Sonnet 5.5 - Coding", provider: "claude", model: "claude-sonnet-5-5", modeId: "auto" },
      ],
    },
  },
};

test("a voice-marked agent.create runs on the Sonnet profile and carries the rule", async () => {
  const hook = createHook("");
  const request = { config: { provider: "claude", cwd: "/nowhere" }, env: { ORCHESTRATOR_VOICE_SESSION: "1" } };
  const out = (await hook({ request }, { paseo: { config: { get: async () => sonnetProfiles } } })) as typeof request & {
    config: { model?: string; modeId?: string; systemPrompt?: string };
  };
  assert.equal(out.config.model, "claude-sonnet-5-5");
  assert.equal(out.config.modeId, "auto");
  assert.match(out.config.systemPrompt ?? "", /Voice routing rule/);
});

test("an unmarked agent.create is left as it was, apart from host MCP servers", async () => {
  const hook = createHook("");
  const request = { config: { provider: "claude", cwd: "/nowhere", systemPrompt: "mine" } };
  const out = (await hook({ request }, { paseo: { config: { get: async () => sonnetProfiles } } })) as typeof request | undefined;
  const config = { ...(out ?? request).config, mcpServers: undefined };
  assert.deepEqual(config, { ...request.config, mcpServers: undefined });
});

test("a failing config.get still gives the marked create the rule, and warns", async () => {
  const hook = createHook("");
  const request = { config: { provider: "claude", cwd: "/nowhere" }, env: { ORCHESTRATOR_VOICE_SESSION: "1" } };
  const warn = console.warn;
  const warned: unknown[][] = [];
  console.warn = (...args: unknown[]) => void warned.push(args);
  try {
    const out = (await hook({ request }, { paseo: { config: { get: async () => Promise.reject(new Error("down")) } } })) as {
      config: { model?: string; systemPrompt?: string };
    };
    assert.equal(out.config.model, undefined);
    assert.match(out.config.systemPrompt ?? "", /Voice routing rule/);
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
});

test("voiceHelperSwitch reads and flips the one switch the interpret RPC obeys", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "voice-helper-"));
  const { handlers, stop } = wired([], true, undefined, undefined, cwd);
  const { paseo, calls } = helperPaseo();
  const flip = handlers.get(voiceHelperSwitch.name);
  const interpret = handlers.get(voiceInterpret.name);
  assert.ok(flip && interpret, "both RPCs are handled");
  const input = { transcript: "hi", sessionId: "s", sessions: [{ id: "s", name: "api" }] };
  assert.deepEqual(await flip({}, { paseo }), { enabled: true });
  assert.deepEqual(await flip({ enabled: false }, { paseo }), { enabled: false });
  assert.deepEqual(await flip({}, { paseo }), { enabled: false });
  // Off: the words go through as heard, and the helper is not even warmed.
  assert.deepEqual(await interpret(input, { paseo }), { result: { type: "send", text: "hi" }, via: "passThrough" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.includes("create"), false);
  assert.deepEqual(await flip({ enabled: true }, { paseo }), { enabled: true });
  stop();
});

test("a Jarvis session opening warms the same helper the drawer's RPCs use", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "voice-helper-"));
  const providers: { connect(): Promise<{ send(input: unknown): Promise<void>; onEvent(fn: (e: unknown) => void): unknown }> }[] = [];
  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>();
  const noop = () => undefined;
  const server = new Proxy({} as PluginServerContext, {
    get: (_target, key) => {
      if (key === "handle") return (rpc: { name: string }, h: never) => void handlers.set(rpc.name, h);
      if (key === "registerProvider") return (p: never) => void providers.push(p);
      if (key === "registerSettings") {
        return () => new Proxy({}, { get: (_t, k) => (k === "read" ? async () => ({ status: "loading" }) : () => noop) });
      }
      return () => noop;
    },
  });
  const stop = contribute(server, { signedIn: async () => true, voiceHelperCwd: cwd, speakerPorts: quietSpeaker });
  const { paseo, calls } = helperPaseo();
  // Providers get no Paseo handle; one RPC hands it over.
  await handlers.get(voiceHelperSwitch.name)!({}, { paseo });
  assert.equal(providers.length, 1, "the Jarvis provider is registered");
  const connection = await providers[0].connect();
  await connection.send({
    type: "session.open",
    requestId: "q1",
    sessionId: "p1",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
    history: "skip",
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.filter((c) => c === "create").length, 2); // the interpret helper and the reply summariser
  // The drawer's start finds it already up.
  await handlers.get(voiceHelperStart.name)!({}, { paseo });
  assert.equal(calls.filter((c) => c === "create").length, 2);
  stop();
});

// Reply summaries: the summariser is a second helper agent; `answer` plays what it says to each reply it is run on.
const longReply = `${"The migration touched every table and rewrote the index. ".repeat(10)}Should I run it now?`;
const longTurn = (id: string, text = longReply) => ({
  agent: { id, workspaceId: null, parentAgentId: null, provider: "claude", cwd: "/x", title: "api" },
  turnId: null,
  outcome: { kind: "completed" },
  timeline: [{ type: "assistant_message", text }],
});

function summaryPaseo(answer: (prompt: string) => Promise<{ status: string; lastMessage: string }>) {
  const prompts: string[] = [];
  const prompts_by_agent = new Map<string, string>();
  let n = 0;
  const paseo = {
    agents: {
      create: async (spec: { config: { systemPrompt: string } }) => {
        n += 1;
        prompts_by_agent.set(`helper-${n}`, spec.config.systemPrompt);
        return { id: `helper-${n}` };
      },
      list: async () => ({ entries: [] }),
      ref: (id: string) => ({
        refresh: async () => null,
        archive: async () => undefined,
        run: async (prompt: string) => {
          if (!prompts_by_agent.get(id)?.includes("spoken summary")) return { status: "idle", lastMessage: "{}" };
          prompts.push(prompt);
          return answer(prompt);
        },
      }),
    },
  };
  return { paseo, prompts };
}

async function summaryRun(
  answer: (prompt: string) => Promise<{ status: string; lastMessage: string }>,
  opts: { off?: boolean; mac?: boolean; text?: string } = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), "voice-helper-"));
  const w = opts.mac ? speakWired([], cwd) : wired([], true, undefined, undefined, cwd);
  const { paseo, prompts } = summaryPaseo(answer);
  if (opts.off) await w.handlers.get(voiceHelperSwitch.name)!({ enabled: false }, { paseo });
  await w.handlers.get(voiceHelperStart.name)!({}, { paseo });
  if (opts.mac) await w.handlers.get(speakRepliesSet.name)!({ agentId: "s1", mode: "short" }, { paseo });
  const started = Date.now();
  await w.listeners.get("agent.turn_ended")!(longTurn("s1", opts.text), { paseo });
  const read = async () => (await w.handlers.get(voiceEvents.name)!({ after: 0 }, { paseo })) as { events: { type: string; text?: string; summary?: string }[] };
  return { ...w, prompts, started, read };
}

test("a reply that will reach a loop is published with its summary, in order before the notice", async () => {
  const run = await summaryRun(async () => ({ status: "idle", lastMessage: "The migration is ready. Should I run it now?" }));
  try {
    await new Promise((r) => setTimeout(r, 50));
    const { events } = await run.read();
    assert.deepEqual(events.map((e) => e.type), ["reply", "notice"]);
    assert.equal(events[0].summary, "The migration is ready. Should I run it now?");
    assert.equal(events[0].text, longReply);
    assert.equal(run.prompts.length, 1);
  } finally {
    run.stop();
  }
});

test("a reply whose summary times out is published without it, within the limit", async () => {
  const run = await summaryRun(() => new Promise(() => undefined));
  try {
    await new Promise((r) => setTimeout(r, 3300));
    const { events } = await run.read();
    assert.ok(Date.now() - run.started < 4000);
    assert.deepEqual(events.map((e) => e.type), ["reply", "notice"]);
    assert.equal(events[0].summary, undefined);
  } finally {
    run.stop();
  }
});

test("a failed summary is published without it, and a later event waits its turn behind the reply", async () => {
  const run = await summaryRun(async () => {
    throw new Error("boom");
  });
  try {
    await run.listeners.get("agent.permission_requested")!({ agent: { id: "s1", provider: "claude", title: "api", cwd: "/x", labels: {} } }, { paseo: summaryPaseo(async () => ({ status: "idle", lastMessage: "" })).paseo });
    await new Promise((r) => setTimeout(r, 50));
    const { events } = await run.read();
    assert.deepEqual(events.map((e) => e.type), ["reply", "notice", "notice"]);
    assert.equal(events[0].summary, undefined);
  } finally {
    run.stop();
  }
});

test("with the helper switch off a reply is published without a summary call", async () => {
  const run = await summaryRun(async () => ({ status: "idle", lastMessage: "A summary." }), { off: true });
  try {
    await new Promise((r) => setTimeout(r, 50));
    const { events } = await run.read();
    assert.equal(events[0].summary, undefined);
    assert.deepEqual(run.prompts, []);
  } finally {
    run.stop();
  }
});

test("a Mac-route reply makes no summary call", async () => {
  const run = await summaryRun(async () => ({ status: "idle", lastMessage: "A summary." }), { mac: true });
  try {
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(run.prompts, []);
  } finally {
    run.stop();
  }
});
