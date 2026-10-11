import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

// The plugin compiler rejects a static node: import in any shared/ module the client or server bundle reaches.
// Node-using modules belong in server/. (shared/brief.ts imports node: lazily, inside a function, which the compiler allows.)
test("no shared/ module imports a node: module at the top level", () => {
  const dir = new URL("./", import.meta.url);
  const offenders = readdirSync(dir)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .filter((name) => /^(import|export)\s[^;]*?from\s+["']node:/m.test(readFileSync(new URL(name, dir), "utf8")));
  assert.deepEqual(offenders, []);
});
