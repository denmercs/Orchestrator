import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "./index.server";

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
