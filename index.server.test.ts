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
