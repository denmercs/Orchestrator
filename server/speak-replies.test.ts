import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { createSpeakReplies, findSpeakScript } from "./speak-replies";

type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];
type Outcome = TurnEnded["outcome"];

const AGENT = { id: "a1", workspaceId: null, parentAgentId: null, provider: "claude", cwd: "/repo", title: null };
const COMPLETED: Outcome = { kind: "completed" };

function reply(outcome: Outcome, ...texts: string[]): TurnEnded {
  const timeline = texts.map((text) => ({ type: "assistant_message", text }));
  return { agent: AGENT, turnId: "t1", outcome, timeline: timeline as unknown as TurnEnded["timeline"] };
}

async function setup(options: { scriptOk?: boolean } = {}) {
  const runs: { args: string[]; stdin?: string }[] = [];
  const speak = createSpeakReplies({
    script: "/repo/scripts/speak",
    run: (args, stdin) => void runs.push({ args, stdin }),
    scriptReady: async () => options.scriptOk ?? true,
  });
  await speak.set("a1", true);
  runs.length = 0;
  return { speak, runs };
}

test("a completed turn speaks the short line of the last assistant message", async () => {
  const { speak, runs } = await setup();
  speak.onTurnEnded(reply(COMPLETED, "Working on it.", "**Done.** Tests pass.\n\nMore detail follows."));
  assert.deepEqual(runs, [{ args: [], stdin: "Done. Tests pass." }]);
});

test("a canceled or failed turn stays silent", async () => {
  const { speak, runs } = await setup();
  speak.onTurnEnded(reply({ kind: "canceled", reason: "interrupted" }, "Half a thought."));
  speak.onTurnEnded(reply({ kind: "failed", error: { message: "boom" } }, "Half a thought."));
  assert.deepEqual(runs, []);
});

test("a switched-off agent stays silent", async () => {
  const { speak, runs } = await setup();
  await speak.set("a1", false);
  runs.length = 0;
  speak.onTurnEnded(reply(COMPLETED, "Hello."));
  speak.onTurnStarted("a1");
  assert.deepEqual(runs, []);
});

test("a code-only reply stays silent", async () => {
  const { speak, runs } = await setup();
  speak.onTurnEnded(reply(COMPLETED, "```ts\nconst a = 1;\n```"));
  speak.onTurnEnded(reply(COMPLETED));
  assert.deepEqual(runs, []);
});

test("a turn starting on a switched-on agent hushes the speaker", async () => {
  const { speak, runs } = await setup();
  speak.onTurnStarted("a1");
  speak.onTurnStarted("other");
  assert.deepEqual(runs, [{ args: ["--hush"], stdin: undefined }]);
});

test("switching on warms the worker and lists the agent", async () => {
  const runs: string[][] = [];
  const speak = createSpeakReplies({ script: "/s", run: (args) => void runs.push(args), scriptReady: async () => true });
  await speak.set("a1", true);
  assert.deepEqual(runs, [["--warm"]]);
  assert.deepEqual(speak.agentIds(), ["a1"]);
});

test("switching off does not unload the worker", async () => {
  const { speak, runs } = await setup();
  await speak.set("a1", false);
  assert.deepEqual(runs, []);
  assert.deepEqual(speak.agentIds(), []);
});

test("a missing script rejects and leaves the agent off", async () => {
  const runs: string[][] = [];
  const speak = createSpeakReplies({ script: "/nope", run: (args) => void runs.push(args), scriptReady: async () => false });
  await assert.rejects(speak.set("a1", true), /\/nope/);
  assert.deepEqual(speak.agentIds(), []);
  assert.deepEqual(runs, []);
});

test("server code avoids import.meta, which is undefined in Paseo's CJS plugin bundle", () => {
  const dir = new URL("./", import.meta.url);
  const offenders = readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .filter((name) => readFileSync(new URL(name, dir), "utf8").includes("import.meta"));
  assert.deepEqual(offenders, []);
});

test("findSpeakScript finds the script inside an install's checkout folder", () => {
  const home = mkdtempSync(join(tmpdir(), "speak-"));
  const dir = join(home, "plugins", "orchestrator", "abc", "checkout", "scripts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "speak"), "#!/bin/sh\n");
  chmodSync(join(dir, "speak"), 0o755);
  assert.equal(findSpeakScript(home), join(dir, "speak"));
  assert.equal(findSpeakScript(join(home, "none")), join(home, "none", "plugins", "orchestrator", "scripts", "speak"));
});
