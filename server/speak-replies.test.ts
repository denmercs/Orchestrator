import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { createSpeakReplies } from "./speak-replies";

type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];
type Outcome = TurnEnded["outcome"];

const AGENT = { id: "a1", workspaceId: null, parentAgentId: null, provider: "claude", cwd: "/repo", title: null };
const COMPLETED: Outcome = { kind: "completed" };

function reply(outcome: Outcome, ...texts: string[]): TurnEnded {
  const timeline = texts.map((text) => ({ type: "assistant_message", text }));
  return { agent: AGENT, turnId: "t1", outcome, timeline: timeline as unknown as TurnEnded["timeline"] };
}

async function setup(options: { mode?: "short" | "medium" | "full" } = {}) {
  const runs: { op: "speak" | "hush"; text?: string }[] = [];
  const speak = createSpeakReplies({
    speak: async (text) => void runs.push({ op: "speak", text }),
    hush: () => void runs.push({ op: "hush" }),
  });
  await speak.set("a1", options.mode ?? "short");
  return { speak, runs };
}

test("a completed turn speaks the short line of the last assistant message", async () => {
  const { speak, runs } = await setup();
  speak.onTurnEnded(reply(COMPLETED, "Working on it.", "**Done.** Tests pass.\n\nMore detail follows."));
  assert.deepEqual(runs, [{ op: "speak", text: "Done. Tests pass." }]);
});

test("full mode speaks every paragraph of the last assistant message", async () => {
  const { speak, runs } = await setup({ mode: "full" });
  speak.onTurnEnded(reply(COMPLETED, "**Done.** Tests pass.\n\n- one\n- two\n\n```ts\nx\n```\n\nMore detail."));
  assert.deepEqual(runs, [{ op: "speak", text: "Done. Tests pass. one. two. More detail." }]);
});

test("switching from short to full changes the mode and says nothing", async () => {
  const { speak, runs } = await setup();
  await speak.set("a1", "full");
  assert.deepEqual(runs, []);
  assert.deepEqual(speak.modes(), { a1: "full" });
});

test("a canceled or failed turn stays silent", async () => {
  const { speak, runs } = await setup();
  speak.onTurnEnded(reply({ kind: "canceled", reason: "interrupted" }, "Half a thought."));
  speak.onTurnEnded(reply({ kind: "failed", error: { message: "boom" } }, "Half a thought."));
  assert.deepEqual(runs, []);
});

test("a switched-off agent stays silent", async () => {
  const { speak, runs } = await setup();
  await speak.set("a1", "off");
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
  assert.deepEqual(runs, [{ op: "hush" }]);
});

test("switching on lists the agent, and switching off removes it", async () => {
  const { speak, runs } = await setup();
  assert.deepEqual(speak.modes(), { a1: "short" });
  assert.equal(speak.has("a1"), true);
  await speak.set("a1", "off");
  assert.deepEqual(speak.modes(), {});
  assert.equal(speak.has("a1"), false);
  assert.deepEqual(runs, []);
});

test("server code avoids import.meta, which is undefined in Paseo's CJS plugin bundle", () => {
  const dir = new URL("./", import.meta.url);
  const offenders = readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .filter((name) => readFileSync(new URL(name, dir), "utf8").includes("import.meta"));
  assert.deepEqual(offenders, []);
});
