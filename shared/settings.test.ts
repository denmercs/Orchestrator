import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpSettings } from "./settings";

test("mcp settings default to excluding nothing", () => {
  assert.deepEqual(mcpSettings.schema.parse({}), { mcpExclude: [] });
});

test("mcp settings keep a given exclude list", () => {
  const parsed = mcpSettings.schema.parse({ mcpExclude: ["mcp-atlassian", "figma-dev"] });
  assert.deepEqual(parsed, { mcpExclude: ["mcp-atlassian", "figma-dev"] });
});
