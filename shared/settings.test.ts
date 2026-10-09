import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetSettings, dashboardSettings, mcpSettings } from "./settings";

test("mcp settings default to excluding nothing", () => {
  assert.deepEqual(mcpSettings.schema.parse({}), { mcpExclude: [] });
});

test("mcp settings keep a given exclude list", () => {
  const parsed = mcpSettings.schema.parse({ mcpExclude: ["mcp-atlassian", "figma-dev"] });
  assert.deepEqual(parsed, { mcpExclude: ["mcp-atlassian", "figma-dev"] });
});

test("dashboard settings are host-scoped at version 1", () => {
  assert.equal(dashboardSettings.id, "dashboard");
  assert.equal(dashboardSettings.scope, "host");
  assert.equal(dashboardSettings.version, 1);
});

test("dashboard settings default to the initiatives tab", () => {
  assert.deepEqual(dashboardSettings.schema.parse({}), { tab: "initiatives" });
});

test("dashboard settings keep a valid stored tab", () => {
  assert.deepEqual(dashboardSettings.schema.parse({ tab: "pulse" }), { tab: "pulse" });
});

test("dashboard settings fall back to initiatives for an unknown tab", () => {
  assert.deepEqual(dashboardSettings.schema.parse({ tab: "bogus" }), { tab: "initiatives" });
});

test("budget settings are host-scoped at version 1", () => {
  assert.equal(budgetSettings.id, "budget");
  assert.equal(budgetSettings.scope, "host");
  assert.equal(budgetSettings.version, 1);
});

test("budget settings default to a $25 day and a $5 story cap", () => {
  assert.deepEqual(budgetSettings.schema.parse({}), { dailyBudgetUsd: 25, storyCapUsd: 5 });
});
