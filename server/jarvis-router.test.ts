import assert from "node:assert/strict";
import { test } from "node:test";
import type { Interpreter } from "../shared/voice-interpreter";
import { CONFIRM_TIMEOUT_MS, type VoiceSession } from "../shared/voice-loop";
import { NOTHING_TO_CONFIRM, notTargetLine, pickFirstLine, SLEEP_LINE, STOPPED_NOTE, WAKE_LINE } from "../shared/voice-lines";
import { createJarvisRouter } from "./jarvis-router";

const api: VoiceSession = { id: "s1", name: "api-refactor" };
const docs: VoiceSession = { id: "s2", name: "docs" };
const self: VoiceSession = { id: "j1", name: "Jarvis" };

function setup(opts: { sessions?: VoiceSession[]; fail?: boolean; interpreter?: Interpreter } = {}) {
  const sent: [string, string][] = [];
  let clock = 0;
  const router = createJarvisRouter({
    sessions: async () => ({ list: opts.sessions ?? [api, docs], blocked: [self] }),
    send: async (id, text) => {
      if (opts.fail) throw new Error("agent not found");
      sent.push([id, text]);
    },
    now: () => clock,
    interpreter: opts.interpreter,
  });
  return { router, sent, tick: (ms: number) => void (clock += ms) };
}

test("with no target it says how to pick one and names a few sessions", async () => {
  const { router, sent } = setup();
  const r = await router.route("r1", "run the tests please");
  assert.deepEqual(r.spoken, [pickFirstLine(["api-refactor", "docs"])]);
  assert.deepEqual(sent, []);
  const none = setup({ sessions: [] });
  assert.deepEqual((await none.router.route("r1", "run the tests please")).spoken, [pickFirstLine([])]);
});

test("switch to <name> picks the target, then speech goes there as heard, without the name", async () => {
  const { router, sent } = setup();
  assert.deepEqual((await router.route("r1", "Jarvis, switch to docs")).spoken, ["Now on docs."]);
  const r = await router.route("r1", "Jarvis, run the tests please.");
  assert.deepEqual(r.spoken, ["Sent to docs."]);
  assert.deepEqual(sent, [["s2", "run the tests please."]]);
});

test("the Voice drawer's target is followed by new and existing routers", async () => {
  const { router, sent } = setup();
  await router.route("r1", "hello");
  await router.setTarget(api);
  await router.route("r1", "run the tests");
  await router.route("r2", "check the build");
  assert.deepEqual(sent, [["s1", "run the tests"], ["s1", "check the build"]]);
});

test("a critical word asks first; one sends it, two cancels, and anything else asks again", async () => {
  const { router, sent } = setup();
  await router.setTarget(api);
  const ask = await router.route("r1", "merge it");
  assert.match(ask.spoken[0], /^Send "merge it" to api-refactor\? Say one to send, or two to cancel\.$/);
  assert.deepEqual(sent, []);
  assert.deepEqual((await router.route("r1", "yes")).spoken, ["Say one to send, or two to cancel."]);
  assert.deepEqual((await router.route("r1", "one")).spoken, ["Sent to api-refactor."]);
  assert.deepEqual(sent, [["s1", "merge it"]]);
  await router.route("r1", "delete the files");
  assert.deepEqual((await router.route("r1", "two")).spoken, ["Cancelled."]);
  await router.route("r1", "delete the branch");
  assert.deepEqual((await router.route("r1", "never mind")).spoken, ["Cancelled."]);
  assert.equal(sent.length, 1);
});

test("stop and interrupt in ordinary speech send without a confirm", async () => {
  const { router, sent } = setup();
  await router.setTarget(api);
  assert.deepEqual((await router.route("r1", "let's stop the build here")).spoken, ["Sent to api-refactor."]);
  assert.deepEqual((await router.route("r1", "don't interrupt the run")).spoken, ["Sent to api-refactor."]);
  assert.equal(sent.length, 2);
});

test("a confirm left too long is dropped by the next utterance", async () => {
  const { router, sent, tick } = setup();
  await router.setTarget(api);
  await router.route("r1", "merge it");
  tick(CONFIRM_TIMEOUT_MS + 1);
  assert.deepEqual((await router.route("r1", "one")).spoken, [NOTHING_TO_CONFIRM]);
  assert.deepEqual(sent, []);
});

test("fragments do nothing and say nothing", async () => {
  const { router, sent } = setup();
  await router.setTarget(api);
  const r = await router.route("r1", "this");
  assert.deepEqual(r, { spoken: [], note: "Nothing sent." });
  assert.deepEqual(sent, []);
});

test("Jarvis, ignore me (or silent mode) goes quiet until the name wakes it", async () => {
  const { router, sent } = setup();
  await router.setTarget(api);
  assert.deepEqual((await router.route("r1", "Jarvis, silent mode")).spoken, [SLEEP_LINE]);
  const asleep = await router.route("r1", "run the tests");
  assert.deepEqual(asleep.spoken, []);
  assert.match(asleep.note ?? "", /asleep/);
  assert.deepEqual((await router.route("r1", "Jarvis, wake up")).spoken, [WAKE_LINE]);
  assert.deepEqual((await router.route("r1", "run the tests")).spoken, ["Sent to api-refactor."]);
  await router.route("r1", "Jarvis, ignore me");
  assert.deepEqual((await router.route("r1", "Jarvis, check the build")).spoken, ["Sent to api-refactor."]);
  assert.deepEqual(sent, [["s1", "run the tests"], ["s1", "check the build"]]);
});

test("a failed send is said instead of the receipt", async () => {
  const { router } = setup({ fail: true });
  await router.setTarget(api);
  assert.deepEqual((await router.route("r1", "run the tests")).spoken, ["Couldn't send to api-refactor: agent not found"]);
});

test("routers keep their own state", async () => {
  const { router } = setup();
  await router.route("r1", "Jarvis, switch to docs");
  assert.equal(router.stateOf("r1")?.session?.id, "s2");
  await router.route("r2", "hello there");
  assert.equal(router.stateOf("r2")?.session, null);
});

test("an interpreter can clean up the words, and the loop still confirms critical ones", async () => {
  const seen: string[] = [];
  const helper: Interpreter = {
    async interpret(text, ctx) {
      seen.push(`${text}|${ctx?.targetTitle}`);
      return text.includes("england") ? { type: "confirm", text: "merge it" } : { type: "send", text: "run the tests in Orchestrator" };
    },
  };
  const { router, sent } = setup({ interpreter: helper });
  await router.setTarget(api);
  assert.deepEqual((await router.route("r1", "run the tests in orchestra tour")).spoken, ["Sent to api-refactor."]);
  assert.match((await router.route("r1", "merge england")).spoken[0], /Say one to send/);
  assert.deepEqual(seen, ["run the tests in orchestra tour|api-refactor", "merge england|api-refactor"]);
  assert.deepEqual(sent, [["s1", "run the tests in Orchestrator"]]);
});

test("a failing interpreter falls back to the words as heard", async () => {
  const { router, sent } = setup({ interpreter: { interpret: async () => Promise.reject(new Error("down")) } });
  await router.setTarget(api);
  await router.route("r1", "Jarvis, run the tests");
  assert.deepEqual(sent, [["s1", "run the tests"]]);
});

test("Voice's own sessions are never a target: the drawer's pick and switch by name are refused", async () => {
  const { router, sent } = setup();
  assert.deepEqual(await router.setTarget(self), { ok: false, line: notTargetLine("Jarvis") });
  assert.deepEqual((await router.route("r1", "run the tests")).spoken, [pickFirstLine(["api-refactor", "docs"])]);
  assert.deepEqual((await router.route("r1", "Jarvis, switch to Jarvis")).spoken, [notTargetLine("Jarvis")]);
  assert.equal(router.stateOf("r1")?.session, null);
  assert.deepEqual(sent, []);
});

test("asleep, a mishearing of the name does not wake it", async () => {
  const { router, sent } = setup();
  await router.setTarget(api);
  await router.route("r1", "Jarvis, silent mode");
  for (const heard of ["Travis, run the tests", "service the car please"]) {
    assert.deepEqual((await router.route("r1", heard)).spoken, [], heard);
  }
  assert.deepEqual((await router.route("r1", "Hey Jarvis")).spoken, [WAKE_LINE]);
  assert.deepEqual(sent, []);
});

test("an aborted route sends nothing and leaves the state as it was", async () => {
  const { router, sent } = setup();
  await router.setTarget(api);
  const abort = new AbortController();
  abort.abort();
  assert.deepEqual(await router.route("r1", "run the tests", abort.signal), { spoken: [], note: STOPPED_NOTE });
  assert.deepEqual(sent, []);
  assert.equal(router.stateOf("r1")?.mode, "listening");
  await router.route("r1", "merge it");
  assert.deepEqual(await router.route("r1", "one", abort.signal), { spoken: [], note: STOPPED_NOTE });
  assert.equal(router.stateOf("r1")?.mode, "confirming");
});

test("on the phone: a list, then a bare number, picks across separate utterances", async () => {
  const phase: VoiceSession = { id: "p", name: "📐 Phase 1 architecture — Talk to a session hands-free" };
  const check: VoiceSession = { id: "c", name: "Check" };
  const { router, sent } = setup({ sessions: [phase, check] });
  assert.deepEqual((await router.route("r1", "Which sessions?")).spoken, ["One, Phase 1 architecture. Two, Check. Say a number, or switch to and a name."]);
  assert.deepEqual((await router.route("r1", "Two.")).spoken, ["Now on Check."]);
  assert.deepEqual((await router.route("r1", "run the tests please")).spoken, ["Sent to Check."]);
  const fresh = setup({ sessions: [phase, check] });
  assert.deepEqual((await fresh.router.route("r2", "Phase One architecture.")).spoken, ["Now on Phase 1 architecture."]);
  assert.deepEqual(sent, [["c", "run the tests please"]]);
});

test("a numbered list expires after the confirm timeout, so a late number picks nothing", async () => {
  const { router, tick } = setup();
  await router.route("r1", "list sessions");
  tick(CONFIRM_TIMEOUT_MS + 1);
  assert.deepEqual((await router.route("r1", "two")).spoken, []);
  assert.equal(router.stateOf("r1")?.session, null);
  await router.route("r1", "list sessions");
  tick(CONFIRM_TIMEOUT_MS - 1);
  assert.deepEqual((await router.route("r1", "two")).spoken, ["Now on docs."]);
});
