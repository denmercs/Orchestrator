import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The plugin build rejects node: modules in the shared bundle; ./memory imports node:crypto and node:fs.
test("the replay RPC file imports only the plugin SDK and zod", () => {
  const source = readFileSync(new URL("./replay-rpc.ts", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ["@getpaseo/plugin", "zod"]);
});
