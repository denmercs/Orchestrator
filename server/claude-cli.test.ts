import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeCli, cliArgs, type RunCli } from "./claude-cli";
import { MODEL } from "./corrections";

function fakeRun(stdout: string) {
  const calls: { args: string[]; input: string }[] = [];
  const run: RunCli = async (args, input) => {
    calls.push({ args, input });
    return stdout;
  };
  return { run, calls };
}
const envelope = (fields: Record<string, unknown>) => JSON.stringify({ type: "result", is_error: false, ...fields });

test("runs one print-mode Haiku call with the system prompt as a flag and the prompt on stdin", async () => {
  const { run, calls } = fakeRun(envelope({ result: "ok", total_cost_usd: 0.002 }));
  await claudeCli(run)("SYSTEM", "PROMPT");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, cliArgs("SYSTEM"));
  assert.equal(calls[0].input, "PROMPT");
  const { args } = calls[0];
  assert.ok(args.includes("-p"));
  assert.equal(args[args.indexOf("--model") + 1], MODEL);
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
  assert.equal(args[args.indexOf("--system-prompt") + 1], "SYSTEM");
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.ok(args.includes("--strict-mcp-config") && args.includes("--no-session-persistence"));
});

test("returns the result text and the reported cost", async () => {
  const { run } = fakeRun(envelope({ result: '{"matches":[]}', total_cost_usd: 0.00215 }));
  assert.deepEqual(await claudeCli(run)("s", "p"), { text: '{"matches":[]}', costUsd: 0.00215 });
});

test("a missing cost counts as zero", async () => {
  const { run } = fakeRun(envelope({ result: "x" }));
  assert.equal((await claudeCli(run)("s", "p")).costUsd, 0);
});

test("an error envelope throws with its message and its cost", async () => {
  const { run } = fakeRun(envelope({ is_error: true, result: "Not logged in", total_cost_usd: 0.001 }));
  await assert.rejects(claudeCli(run)("s", "p"), (error: Error & { costUsd?: number }) => {
    assert.match(error.message, /Not logged in/);
    assert.equal(error.costUsd, 0.001);
    return true;
  });
});

test("output that is not JSON throws", async () => {
  const { run } = fakeRun("command not found");
  await assert.rejects(claudeCli(run)("s", "p"), /not JSON/);
});
