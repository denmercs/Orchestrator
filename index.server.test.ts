import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "./index.server";
import { startMemoryReplay } from "./shared/replay-rpc";
import { voiceHelperStart, voiceHelperStop, voiceInterpret } from "./shared/voice-rpc";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  contribute(server);
  return ids;
}

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
  contribute(server);
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
  contribute(server);
  return ids;
}

test("registers the Kiro usage source when the host has registerUsageSource", () => {
  assert.deepEqual(usageSourceIds({ registerUsageSource: true }), ["kiro"]);
});

test("still loads on a host without registerUsageSource", () => {
  assert.deepEqual(usageSourceIds({}), []);
});

type Fake = {
  pending: string[];
  calls: string[];
  replayed: unknown[];
};

function wired(
  pending: string[] = [],
  signedIn = true,
  replayStart?: { file: string; everyMs: number },
  loopStart?: { file: string; everyMs: number },
  voiceHelperCwd?: string,
) {
  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>();
  const listeners = new Map<string, (event: unknown, context: unknown) => unknown>();
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
      if (key === "registerSettings") {
        return () => new Proxy({}, { get: (_t, k) => (k === "read" ? async () => ({ status: "loading" }) : () => noop) });
      }
      // Anything else hands back an unsubscribe, so the cleanup contribute returns can run.
      return () => noop;
    },
  });
  const stop = contribute(server, { replay: runner, signedIn: async () => signedIn, replayStart, loopStart, voiceHelperCwd });
  return { handlers, listeners, fake, stop };
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

const turnAgent = (id: string) => ({ id, workspaceId: null, parentAgentId: null, provider: "claude", cwd: "/x", title: null });

test("the voice helper RPCs start and stop one helper agent, and interpret fails while it is stopped", async () => {
  const cwd = join(mkdtempSync(join(tmpdir(), "voice-helper-")), "nested", "helper");
  const { handlers, stop } = wired([], true, undefined, undefined, cwd);
  const { paseo, calls } = helperPaseo();
  const start = handlers.get(voiceHelperStart.name);
  const halt = handlers.get(voiceHelperStop.name);
  const interpret = handlers.get(voiceInterpret.name);
  assert.ok(start && halt && interpret, "all three RPCs are handled");
  const input = { transcript: "hi", sessionId: "s", sessions: [{ id: "s", name: "api" }] };
  await assert.rejects(async () => interpret(input, { paseo }), /not started/);
  assert.deepEqual(await start({}, { paseo }), { ok: true });
  assert.equal(existsSync(cwd), true, "the helper's folder is made before the agent is created");
  await start({}, { paseo });
  assert.equal(calls.filter((c) => c === "create").length, 1);
  assert.deepEqual(await halt({}, { paseo }), { ok: true });
  assert.ok(calls.includes("archive:helper-1"));
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

test("disposing the plugin archives the voice helper", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "voice-helper-"));
  const { handlers, stop } = wired([], true, undefined, undefined, cwd);
  const { paseo, calls } = helperPaseo();
  await handlers.get(voiceHelperStart.name)!({}, { paseo });
  stop();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(calls.includes("archive:helper-1"));
});
