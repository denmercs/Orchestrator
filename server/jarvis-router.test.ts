import assert from "node:assert/strict";
import { test } from "node:test";
import type { Interpreter } from "../shared/voice-interpreter";
import { CONFIRM_TIMEOUT_MS, type VoiceSession } from "../shared/voice-loop";
import { NOTHING_TO_CONFIRM, notTargetLine, pickFirstLine, SLEEP_LINE, STOPPED_NOTE, WAKE_LINE } from "../shared/voice-lines";
import type { BriefData } from "../shared/morning-brief";
import { VOICE_ROUTING_PREAMBLE, VOICE_SESSION_ENV } from "../shared/voice-session";
import { createJarvisRouter, voiceSessionCreator } from "./jarvis-router";

const api: VoiceSession = { id: "s1", name: "api-refactor" };
const docs: VoiceSession = { id: "s2", name: "docs" };
const self: VoiceSession = { id: "j1", name: "Jarvis" };

function setup(opts: { sessions?: VoiceSession[]; fail?: boolean; interpreter?: Interpreter; createFail?: boolean } = {}) {
  // `raw` is what the sessions received; `sent` is the same with the one-time routing preamble taken off, so the
  // tests that aren't about the preamble read the words alone.
  const raw: [string, string][] = [];
  const sent: [string, string][] = [];
  const created: unknown[] = [];
  let clock = 0;
  const router = createJarvisRouter({
    sessions: async () => ({ list: opts.sessions ?? [api, docs], blocked: [self] }),
    send: async (id, text) => {
      if (opts.fail) throw new Error("agent not found");
      raw.push([id, text]);
      sent.push([id, text.replace(`${VOICE_ROUTING_PREAMBLE}\n\n`, "")]);
    },
    create: async (target) => {
      if (opts.createFail) throw new Error("no room");
      created.push(target);
      return "new1";
    },
    now: () => clock,
    interpreter: opts.interpreter,
  });
  return { router, sent, raw, created, tick: (ms: number) => void (clock += ms) };
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
  await router.route("r1", "stop the build");
  assert.deepEqual((await router.route("r1", "two")).spoken, ["Cancelled."]);
  await router.route("r1", "delete the branch");
  assert.deepEqual((await router.route("r1", "never mind")).spoken, ["Cancelled."]);
  assert.equal(sent.length, 1);
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

test("a new session is created marked, becomes the target, and is never briefed", async () => {
  const { router, raw, created } = setup();
  await router.setTarget(api);
  const r = await router.route("r1", "start a new session");
  assert.deepEqual(created, [api]);
  assert.match(r.spoken[0], /^Starting a voice session in /);
  assert.equal(router.stateOf("r1")?.session?.id, "new1");
  await router.route("r1", "run the tests");
  assert.deepEqual(raw, [["new1", "run the tests"]]);
});

test("voiceSessionCreator makes a marked session on the target's provider, no model, in its workspace or folder", async () => {
  const calls: unknown[] = [];
  const make = (workspaceId: string | null) =>
    voiceSessionCreator(() => ({
      agents: {
        ref: () => ({ refresh: async () => ({ agent: { cwd: "/w", provider: "claude", workspaceId } }) }),
        create: async (o) => (calls.push(["agents", o]), { id: "a1" }),
      },
      workspaces: { ref: (id) => ({ agents: { create: async (o) => (calls.push([id, o]), { id: "a2" }) } }) },
    }));
  const env = { [VOICE_SESSION_ENV]: "1" };
  assert.equal(await make(null)(api), "a1");
  assert.equal(await make("ws")(api), "a2");
  assert.deepEqual(calls, [["agents", { cwd: "/w", config: { provider: "claude" }, env }], ["ws", { config: { provider: "claude" }, env }]]);
});

test("the first steer to an unmarked target carries the routing preamble once", async () => {
  const { router, raw } = setup();
  await router.setTarget(api);
  await router.route("r1", "run the tests");
  await router.route("r1", "check the build");
  assert.deepEqual(raw, [["s1", `${VOICE_ROUTING_PREAMBLE}\n\nrun the tests`], ["s1", "check the build"]]);
});

test("a failing create speaks a failure line and keeps the old target", async () => {
  const { router, raw } = setup({ createFail: true });
  await router.setTarget(api);
  const r = await router.route("r1", "start a new session");
  assert.ok(r.spoken.some((line) => line.includes("no room")));
  assert.equal(router.stateOf("r1")?.session?.id, "s1");
  await router.route("r1", "run the tests");
  assert.equal(raw.at(-1)?.[0], "s1");
});

test("event() steps every router and returns lines per router; owed lines are prepended once to the next route()", async () => {
  const { router } = setup();
  await router.setTarget(api);
  await router.route("r1", "hello");
  await router.route("r2", "hello");
  const lines = await router.event({ type: "reply", sessionId: "s1", text: "All done." });
  assert.deepEqual(lines, { r1: ["api-refactor: All done."], r2: ["api-refactor: All done."] });
  // Other sessions' notices come out as one line per router; replies for non-targets say nothing.
  assert.deepEqual(await router.event({ type: "reply", sessionId: "s2", text: "ignored" }), { r1: [], r2: [] });
  router.playbackEnded("r1");
  assert.equal(router.stateOf("r1")?.mode, "listening");
  assert.equal(router.stateOf("r2")?.mode, "speaking");
  // A line Jarvis could not say is owed: said first at the next words, once.
  router.owe("r1", ["Docs finished."]);
  assert.deepEqual((await router.route("r1", "run the tests")).spoken, ["Docs finished.", "Sent to api-refactor."]);
  assert.deepEqual((await router.route("r1", "run the tests")).spoken, ["Sent to api-refactor."]);
});

// The morning briefing.
const briefData: BriefData = {
  name: "Dennis",
  at: new Date(2026, 9, 13, 7, 42).getTime(),
  weather: null,
  verse: { reference: "Psalm 118:24", text: "This is the day." },
  stories: ["Fix playback resume"],
  initiative: { title: "Orchestration Redesign", detail: "one story needs you", running: false },
};

function briefSetup(opts: { gather?: () => Promise<BriefData>; startError?: string | null } = {}) {
  const started: string[] = [];
  let clock = 0;
  const sent: [string, string][] = [];
  const router = createJarvisRouter({
    sessions: async () => ({ list: [api, docs], blocked: [self] }),
    send: async (id, text) => void sent.push([id, text]),
    now: () => clock,
    create: async () => "new1",
    brief: {
      gather: opts.gather ?? (async () => briefData),
      startInitiative: async () => {
        started.push("start");
        return opts.startError ?? null;
      },
    },
  });
  return { router, started, sent, tick: (ms: number) => void (clock += ms) };
}

test("good morning runs the briefing, then yes starts the initiative and ends with the joke", async () => {
  const { router, started } = briefSetup();
  const open = await router.route("r1", "Good morning");
  assert.match(open.spoken[0], /^Good morning, Dennis\./);
  assert.match(open.spoken.at(-1) ?? "", /Shall I start the loop\?$/);
  const go = await router.route("r1", "yes");
  assert.equal(go.spoken[0], "Starting Orchestration Redesign.");
  assert.equal(go.spoken.at(-1), "Will that be all?");
  assert.deepEqual(started, ["start"]);
});

test("a failed start is said, and the briefing still signs off", async () => {
  const { router } = briefSetup({ startError: "Pick a repo first." });
  await router.route("r1", "good morning");
  const go = await router.route("r1", "do it");
  assert.equal(go.spoken[0], "I couldn't start it: Pick a repo first.");
  assert.equal(go.spoken.at(-1), "Will that be all?");
});

test("words that are not an answer end the briefing and reach the normal loop", async () => {
  const { router, started, sent } = briefSetup();
  await router.route("r1", "Jarvis, switch to docs");
  await router.route("r1", "good morning");
  const r = await router.route("r1", "Jarvis, run the tests please");
  assert.deepEqual(r.spoken, ["Sent to docs."]);
  assert.deepEqual(sent, [["s2", `${VOICE_ROUTING_PREAMBLE}\n\nrun the tests please`]]);
  assert.deepEqual(started, []);
  // The briefing is over, so a bare yes is no longer its answer.
  assert.notDeepEqual((await router.route("r1", "yes")).spoken.slice(0, 1), ["Starting Orchestration Redesign."]);
});

test("an unanswered briefing lapses, so a later yes does not start the loop", async () => {
  const { router, started, tick } = briefSetup();
  await router.route("r1", "good morning");
  tick(121_000);
  await router.route("r1", "yes");
  assert.deepEqual(started, []);
});

test("asleep, a good morning to someone else is ignored; with the name it wakes and briefs", async () => {
  const { router } = briefSetup();
  await router.route("r1", "Jarvis, silent mode");
  const ignored = await router.route("r1", "good morning");
  assert.doesNotMatch(ignored.spoken[0] ?? "", /^Good morning, Dennis/);
  const woke = await router.route("r1", "Jarvis, good morning");
  assert.match(woke.spoken[0], /^Good morning, Dennis\./);
});

test("if the data can't be gathered it says so instead of going quiet", async () => {
  const { router } = briefSetup({ gather: async () => Promise.reject(new Error("offline")) });
  const r = await router.route("r1", "good morning");
  assert.deepEqual(r.spoken, ["I couldn't pull the briefing together: offline"]);
});

test("a line owed to the next words is not spoken with the briefing, and is said once after it", async () => {
  const { router } = briefSetup();
  router.owe("r1", ["Docs finished."]);
  const brief = await router.route("r1", "good morning");
  assert.doesNotMatch(brief.spoken.join(" "), /Docs finished/);
  await router.route("r1", "never mind");
  const after = await router.route("r1", "Jarvis, switch to docs");
  assert.equal(after.spoken.filter((line) => line === "Docs finished.").length, 1);
  assert.equal((await router.route("r1", "Jarvis, switch to api")).spoken.includes("Docs finished."), false);
});

test("brief() answers a good morning and its replies without touching the Voice loop; other words are null", async () => {
  const { router, started, sent } = briefSetup();
  assert.equal(await router.brief("drawer", "run the tests"), null);
  const open = await router.brief("drawer", "good morning");
  assert.match(open?.spoken[0] ?? "", /^Good morning, Dennis\./);
  const go = await router.brief("drawer", "do it");
  assert.equal(go?.spoken[0], "Starting Orchestration Redesign.");
  assert.deepEqual(started, ["start"]);
  assert.deepEqual(sent, []);
});

test("brief() ends an open briefing on words that are not an answer", async () => {
  const { router, started } = briefSetup();
  await router.brief("drawer", "good morning");
  assert.equal(await router.brief("drawer", "run the tests please"), null);
  assert.equal(await router.brief("drawer", "yes"), null);
  assert.deepEqual(started, []);
});

test("event() carries a watched reply from a non-target session to every router, one line each", async () => {
  const { router } = setup();
  await router.setTarget(api);
  await router.route("r1", "hello");
  const lines = await router.event({ type: "reply", sessionId: "s2", text: "All **done**.", watched: true });
  assert.deepEqual(lines, { r1: ["docs: All done."] });
});

test("listening() is true only while a phone router's loop is awake, so a reply the loop would drop can fall back to the Mac", async () => {
  const { router } = setup();
  assert.equal(router.listening(), false);
  await router.setTarget(api);
  await router.route("r1", "hello");
  assert.equal(router.listening(), true);
  await router.route("r1", "Jarvis, ignore me");
  assert.equal(router.listening(), false);
});
