import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseArgs, run } from "./motion-brief.mjs";

test("parseArgs reads the flags and defaults base to main and head to HEAD", () => {
  assert.deepEqual(parseArgs(["--base", "dev", "--head", "feat", "--out", "/o", "--json", "m.json"]), {
    base: "dev",
    head: "feat",
    out: "/o",
    json: "m.json",
  });
  assert.deepEqual(parseArgs([]), { base: "main", head: "HEAD", out: undefined, json: undefined });
  assert.throws(() => parseArgs(["--base"]), /--base needs a value/);
});

test("run passes the repo, refs and out folder to motionBrief and prints the result", async () => {
  const lines = [];
  const calls = [];
  const brief = async (input, write) => {
    calls.push({ input, write });
    return { file: "/o/motion.md", text: "x", cut: [{ path: "yarn.lock", reason: "generated" }], problems: ["scenes: 5 passed"], motion: null };
  };
  await run(["--out", "/o"], { brief, log: (l) => lines.push(l), root: "/repo" });
  assert.deepEqual(calls[0].input, { worktree: "/repo", base: "main", head: "HEAD", outDir: "/o" });
  assert.equal(calls[0].write, undefined, "the Sonnet writer is the default");
  assert.deepEqual(lines, ["motion.md: /o/motion.md", "cut for size: yarn.lock (generated)", "problem: scenes: 5 passed"]);
});

test("--json re-renders an edited motion.json with no writer agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "motion-cli-"));
  try {
    writeFileSync(join(dir, "m.json"), '{"title":"T"}');
    let reply;
    const brief = async (_input, write) => {
      reply = await write("system", "diff");
      return { file: null, text: null, cut: [], problems: ["No architectural decision in this diff."], motion: null };
    };
    const lines = [];
    await run(["--json", join(dir, "m.json"), "--out", "/o"], { brief, log: (l) => lines.push(l), root: "/repo" });
    assert.deepEqual(reply, { text: '{"title":"T"}', costUsd: 0 });
    assert.deepEqual(lines, ["no motion.md written", "problem: No architectural decision in this diff."]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
