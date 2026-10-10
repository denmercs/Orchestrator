import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "./index.server";
import { startMemoryReplay } from "./shared/replay-rpc";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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

function wired(pending: string[] = []) {
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
        return () => new Proxy({}, { get: (_t, k) => (k === "read" ? async () => ({ status: "loading" }) : noop) });
      }
      return noop;
    },
  });
  contribute(server, { replay: runner });
  return { handlers, listeners, fake };
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

test("startMemoryReplay says clearly when the corpus is missing", async () => {
  const { handlers } = wired();
  const handler = handlers.get(startMemoryReplay.name);
  assert.ok(handler);
  await assert.rejects(async () => handler({ root: repoWithCorpus(null) }, { paseo: {} }), /corpus\.jsonl.*corpus\.mjs/s);
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
