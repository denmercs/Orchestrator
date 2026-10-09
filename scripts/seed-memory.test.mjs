import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs, run } from "./seed-memory.mjs";

test("parseArgs maps flags to analyze options", () => {
  assert.deepEqual(parseArgs(["--as-of", "2026-01-02", "--cap", "1.5", "--exclude", "s7"]), {
    asOf: "2026-01-02",
    costCap: 1.5,
    excludeStory: "s7",
  });
  assert.deepEqual(parseArgs([]), { asOf: undefined, costCap: 3, excludeStory: undefined });
});

test("run prints the cap before analyze, then the result", async () => {
  const lines = [];
  const calls = [];
  const analyze = async (root, opts) => {
    lines.push("analyze");
    calls.push({ root, opts });
    return { written: ["a", "b"], removed: ["c"], skipped: [], summary: "", spentUsd: 0.12345, stopped: "cap" };
  };
  await run(["--cap", "2"], { analyze, log: (l) => lines.push(l), root: "/repo" });
  assert.equal(lines[0], "cost cap $2.00");
  assert.equal(lines[1], "analyze");
  assert.equal(calls[0].root, "/repo");
  assert.equal(calls[0].opts.costCap, 2);
  const out = lines.slice(2).join("\n");
  assert.match(out, /written 2/);
  assert.match(out, /removed 1/);
  assert.match(out, /skipped 0/);
  assert.match(out, /\$0\.1235/);
  assert.match(out, /stopped at cap/);
});

test("run reports an error stop and defaults the cap to $3", async () => {
  const lines = [];
  const analyze = async () => ({ written: [], removed: [], skipped: [], summary: "", spentUsd: 0, stopped: "error" });
  await run([], { analyze, log: (l) => lines.push(l), root: "/repo" });
  assert.equal(lines[0], "cost cap $3.00");
  assert.match(lines.join("\n"), /stopped: error/);
});
