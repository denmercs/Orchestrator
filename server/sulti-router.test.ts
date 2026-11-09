import assert from "node:assert/strict";
import { test } from "node:test";
import type { InterpretOutcome } from "../shared/voice-interpreter";
import { CONFIRM_TIMEOUT_MS, type VoiceSession } from "../shared/voice-loop";
import { DIDNT_CATCH_NOTE, NOTHING_TO_CONFIRM, notTargetLine, pickFirstLine, SENT_NOTE, SLEEP_LINE, STOPPED_NOTE, WAKE_LINE } from "../shared/voice-lines";
import type { BriefData } from "../shared/morning-brief";
import type { StatusAgent } from "../shared/voice-status";
import { VOICE_ROUTING_PREAMBLE, VOICE_SESSION_ENV } from "../shared/voice-session";
import { createSultiRouter, DASHBOARD_ROUTER, MAC_ROUTER, voiceSessionCreator, type SultiInterpreter } from "./sulti-router";

const api: VoiceSession = { id: "s1", name: "api-refactor" };
const docs: VoiceSession = { id: "s2", name: "docs" };
const self: VoiceSession = { id: "j1", name: "Sulti" };

function setup(opts: { sessions?: VoiceSession[]; fail?: boolean; interpreter?: SultiInterpreter; createFail?: boolean; sulti?: () => Promise<string | null>; blocked?: VoiceSession[] } = {}) {
  // `raw` is what the sessions received; `sent` is the same with the one-time routing preamble taken off, so the
  // tests that aren't about the preamble read the words alone.
  const raw: [string, string][] = [];
  const sent: [string, string][] = [];
  const created: unknown[] = [];
  let clock = 0;
  const router = createSultiRouter({
    sessions: async () => ({ list: opts.sessions ?? [api, docs], blocked: opts.blocked ?? [self] }),
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
    sulti: opts.sulti,
  });
  return { router, sent, raw, created, tick: (ms: number) => void (clock += ms) };
}

// Picks api-refactor by voice on each router (r1 by default), the way a phone router gets its target.
async function pick(router: ReturnType<typeof createSultiRouter>, ...routerIds: string[]) {
  for (const id of routerIds.length ? routerIds : ["r1"]) await router.route(id, "Sulti, switch to api-refactor");
}

test("with no target it shows how to pick one (note only, nothing said) and names a few sessions", async () => {
  const { router, sent } = setup();
  const r = await router.route("r1", "run the tests please");
  assert.deepEqual(r, { spoken: [], note: pickFirstLine(["api-refactor", "docs"]) });
  assert.deepEqual(sent, []);
  const none = setup({ sessions: [] });
  assert.deepEqual(await none.router.route("r1", "run the tests please"), { spoken: [], note: pickFirstLine([]) });
});

test("with no target and a line owed, the owed line is said and the pick text still lands in note", async () => {
  const { router } = setup();
  router.owe("r1", ["Docs finished."]);
  assert.deepEqual(await router.route("r1", "run the tests please"), { spoken: ["Docs finished."], note: pickFirstLine(["api-refactor", "docs"]) });
});

test("a line owed more than once is said once, in the order first owed", async () => {
  const { router } = setup();
  router.owe("r1", ["Docs finished.", "Api finished."]);
  router.owe("r1", ["Docs finished.", "Api finished.", "Docs finished."]);
  assert.deepEqual((await router.route("r1", "run the tests please")).spoken, ["Docs finished.", "Api finished."]);
});

test("switch to <name> picks the target, then speech goes there as heard, without the name", async () => {
  const { router, sent } = setup();
  assert.deepEqual((await router.route("r1", "Sulti, switch to docs")).spoken, ["Now on docs."]);
  const r = await router.route("r1", "Sulti, run the tests please.");
  assert.deepEqual(r.spoken, []);
  assert.deepEqual(sent, [["s2", "run the tests please."]]);
});

test("a router never follows another router's pick, new or existing", async () => {
  const { router, sent } = setup();
  await router.route("r2", "hello");
  await router.route("r1", "Sulti, switch to docs");
  // Neither an existing router (r2) nor a new one (r3) follows r1's pick.
  assert.deepEqual(await router.route("r2", "run the tests"), { spoken: [], note: pickFirstLine(["api-refactor", "docs"]) });
  assert.deepEqual(await router.route("r3", "run the tests"), { spoken: [], note: pickFirstLine(["api-refactor", "docs"]) });
  assert.deepEqual(sent, []);
});

test("no word, merge and delete included, asks for a confirm; it just sends", async () => {
  const { router, sent } = setup();
  await pick(router);
  assert.deepEqual((await router.route("r1", "let's stop the build here")).spoken, []);
  assert.deepEqual((await router.route("r1", "don't interrupt the run")).spoken, []);
  assert.deepEqual((await router.route("r1", "merge it")).spoken, []);
  assert.deepEqual((await router.route("r1", "delete the branch")).spoken, []);
  assert.equal(sent.length, 4);
});

test("a steer that went out is not reported as 'Nothing sent.', and says nothing aloud", async () => {
  const { router, sent } = setup();
  await pick(router);
  const r = await router.route("r1", "run the tests please");
  assert.deepEqual(sent, [["s1", "run the tests please"]]);
  assert.deepEqual(r, { spoken: [], note: SENT_NOTE });
});

test("empty speech is 'didn't catch that', not a routing failure", async () => {
  const { router, sent } = setup();
  await pick(router);
  assert.deepEqual(await router.route("r1", "  "), { spoken: [], note: DIDNT_CATCH_NOTE });
  assert.deepEqual(sent, []);
});

test("fragments do nothing and say nothing", async () => {
  const { router, sent } = setup();
  await pick(router);
  const r = await router.route("r1", "this");
  assert.deepEqual(r, { spoken: [], note: "Nothing sent." });
  assert.deepEqual(sent, []);
});

test("Sulti, ignore me (or silent mode) goes quiet until the name wakes it", async () => {
  const { router, sent } = setup();
  await pick(router);
  assert.deepEqual((await router.route("r1", "Sulti, silent mode")).spoken, [SLEEP_LINE]);
  const asleep = await router.route("r1", "run the tests");
  assert.deepEqual(asleep.spoken, []);
  assert.match(asleep.note ?? "", /asleep/);
  assert.deepEqual((await router.route("r1", "Sulti, wake up")).spoken, [WAKE_LINE]);
  assert.deepEqual((await router.route("r1", "run the tests")).spoken, []);
  await router.route("r1", "Sulti, ignore me");
  assert.deepEqual((await router.route("r1", "Sulti, check the build")).spoken, []);
  assert.deepEqual(sent, [["s1", "run the tests"], ["s1", "check the build"]]);
});

test("a failed send is said instead of a silent success", async () => {
  const { router } = setup({ fail: true });
  await pick(router);
  assert.deepEqual((await router.route("r1", "run the tests")).spoken, ["Couldn't send to api-refactor: agent not found"]);
});

test("routers keep their own state", async () => {
  const { router } = setup();
  await router.route("r1", "Sulti, switch to docs");
  assert.equal(router.stateOf("r1")?.session?.id, "s2");
  await router.route("r2", "hello there");
  assert.equal(router.stateOf("r2")?.session, null);
});

const helped = (result: InterpretOutcome["result"]): InterpretOutcome => ({ result, via: "helper" });

test("an interpreter gets the target's id and the sessions, and its result reaches the loop (a risky one still just sends)", async () => {
  const seen: unknown[] = [];
  const helper: SultiInterpreter = {
    async interpret(text, req) {
      seen.push([text, req.sessionId, req.sessions.map((s) => s.name)]);
      return helped(text.includes("england") ? { type: "send", text: "merge it" } : { type: "send", text: "run the tests in Orchestrator" });
    },
  };
  const { router, sent } = setup({ interpreter: helper });
  await pick(router);
  assert.deepEqual((await router.route("r1", "run the tests in orchestra tour")).spoken, []);
  assert.deepEqual((await router.route("r1", "merge england")).spoken, []);
  assert.deepEqual(seen, [
    ["run the tests in orchestra tour", "s1", ["api-refactor", "docs"]],
    ["merge england", "s1", ["api-refactor", "docs"]],
  ]);
  assert.deepEqual(sent, [["s1", "run the tests in Orchestrator"], ["s1", "merge it"]]);
});

test("a failing interpreter falls back to the words as heard", async () => {
  const { router, sent } = setup({ interpreter: { interpret: async () => Promise.reject(new Error("down")) } });
  await pick(router);
  await router.route("r1", "Sulti, run the tests");
  assert.deepEqual(sent, [["s1", "run the tests"]]);
});

test("a fallback reason adds a note to the chat text only, never to what is spoken", async () => {
  for (const [reason, note] of [
    ["timeout", "Helper timed out, sent as heard"],
    ["error", "Helper failed, sent as heard"],
    ["starting", "Helper starting, sent as heard"],
  ] as const) {
    const { router, sent } = setup({
      interpreter: { interpret: async (text) => ({ result: { type: "send", text }, via: "passThrough", reason }) },
    });
    await pick(router);
    const r = await router.route("r1", "run the tests");
    assert.deepEqual(r.spoken, []);
    assert.equal(r.note, note);
    assert.deepEqual(sent, [["s1", "run the tests"]]);
  }
  // A clean helper answer has no note.
  const { router } = setup({ interpreter: { interpret: async (text) => helped({ type: "send", text }) } });
  await pick(router);
  assert.equal((await router.route("r1", "run the tests")).note, SENT_NOTE);
});

test("Voice's own sessions are never a target: switch by name is refused", async () => {
  const { router, sent } = setup();
  assert.deepEqual(await router.route("r1", "run the tests"), { spoken: [], note: pickFirstLine(["api-refactor", "docs"]) });
  assert.deepEqual((await router.route("r1", "Sulti, switch to Sulti")).spoken, [notTargetLine("Sulti")]);
  assert.equal(router.stateOf("r1")?.session, null);
  assert.deepEqual(sent, []);
});

test("asleep, a mishearing of the name does not wake it", async () => {
  const { router, sent } = setup();
  await pick(router);
  await router.route("r1", "Sulti, silent mode");
  for (const heard of ["Travis, run the tests", "service the car please"]) {
    assert.deepEqual((await router.route("r1", heard)).spoken, [], heard);
  }
  assert.deepEqual((await router.route("r1", "Hey Sulti")).spoken, [WAKE_LINE]);
  assert.deepEqual(sent, []);
});

test("an aborted route sends nothing and leaves the state as it was", async () => {
  const { router, sent } = setup();
  await pick(router);
  const abort = new AbortController();
  abort.abort();
  assert.deepEqual(await router.route("r1", "run the tests", abort.signal), { spoken: [], note: STOPPED_NOTE });
  assert.deepEqual(sent, []);
  assert.equal(router.stateOf("r1")?.mode, "listening");
});

test("on the phone: a list, then a bare number, picks across separate utterances", async () => {
  const phase: VoiceSession = { id: "p", name: "📐 Phase 1 architecture — Talk to a session hands-free" };
  const check: VoiceSession = { id: "c", name: "Check" };
  const { router, sent } = setup({ sessions: [phase, check] });
  assert.deepEqual((await router.route("r1", "Which sessions?")).spoken, ["One, Phase 1 architecture. Two, Check. Say a number, or switch to and a name."]);
  assert.deepEqual((await router.route("r1", "Two.")).spoken, ["Now on Check."]);
  assert.deepEqual((await router.route("r1", "run the tests please")).spoken, []);
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
  await pick(router);
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
  await pick(router);
  await router.route("r1", "run the tests");
  await router.route("r1", "check the build");
  assert.deepEqual(raw, [["s1", `${VOICE_ROUTING_PREAMBLE}\n\nrun the tests`], ["s1", "check the build"]]);
});

test("a failing create speaks a failure line and keeps the old target", async () => {
  const { router, raw } = setup({ createFail: true });
  await pick(router);
  const r = await router.route("r1", "start a new session");
  assert.ok(r.spoken.some((line) => line.includes("no room")));
  assert.equal(router.stateOf("r1")?.session?.id, "s1");
  await router.route("r1", "run the tests");
  assert.equal(raw.at(-1)?.[0], "s1");
});

test("event() steps every router and returns lines per router; owed lines are prepended once to the next route()", async () => {
  const { router } = setup();
  await pick(router, "r1", "r2");
  const lines = await router.event({ type: "reply", sessionId: "s1", text: "All done." });
  assert.deepEqual(lines, { r1: ["api-refactor: All done."], r2: ["api-refactor: All done."] });
  // Other sessions' notices come out as one line per router; replies for non-targets say nothing.
  assert.deepEqual(await router.event({ type: "reply", sessionId: "s2", text: "ignored" }), { r1: [], r2: [] });
  router.playbackEnded("r1");
  assert.equal(router.stateOf("r1")?.mode, "listening");
  assert.equal(router.stateOf("r2")?.mode, "speaking");
  // A line Sulti could not say is owed: said first at the next words, once.
  router.owe("r1", ["Docs finished."]);
  assert.deepEqual((await router.route("r1", "run the tests")).spoken, ["Docs finished."]);
  assert.deepEqual((await router.route("r1", "run the tests")).spoken, []);
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

function briefSetup(opts: { gather?: () => Promise<BriefData> } = {}) {
  let clock = 0;
  const sent: [string, string][] = [];
  const router = createSultiRouter({
    sessions: async () => ({ list: [api, docs], blocked: [self] }),
    send: async (id, text) => void sent.push([id, text]),
    now: () => clock,
    create: async () => "new1",
    brief: {
      gather: opts.gather ?? (async () => briefData),
    },
  });
  return { router, sent, tick: (ms: number) => void (clock += ms) };
}

test("good morning runs the briefing and ends with the joke; the initiative line offers nothing", async () => {
  const { router, sent } = briefSetup();
  const open = await router.route("r1", "Good morning");
  assert.match(open.spoken[0], /^Good morning, Dennis\./);
  assert.ok(open.spoken.some((line) => line.endsWith("one story needs you.")));
  assert.equal(open.spoken.at(-1), "Will that be all?");
  assert.doesNotMatch(open.spoken.join(" "), /Shall I start/);
  const go = await router.route("r1", "do it");
  assert.equal(go.spoken.some((line) => line.startsWith("Starting ")), false);
  assert.deepEqual(sent, []);
});

test("words that are not an answer end the briefing and reach the normal loop", async () => {
  const { router, sent } = briefSetup();
  await router.route("r1", "Sulti, switch to docs");
  await router.route("r1", "good morning");
  const r = await router.route("r1", "Sulti, run the tests please");
  assert.deepEqual(r.spoken, []);
  assert.deepEqual(sent, [["s2", `${VOICE_ROUTING_PREAMBLE}\n\nrun the tests please`]]);
  // The briefing is over, so a bare yes is no longer its answer.
  assert.equal((await router.route("r1", "yes")).spoken.some((line) => line.startsWith("Starting ")), false);
});

test("an unanswered briefing lapses, so a later yes is not its answer", async () => {
  const { router, sent, tick } = briefSetup();
  await router.route("r1", "good morning");
  tick(121_000);
  const late = await router.route("r1", "yes");
  assert.equal(late.spoken.some((line) => line.startsWith("Starting ")), false);
  assert.deepEqual(sent, []);
});

test("asleep, a good morning to someone else is ignored; with the name it wakes and briefs", async () => {
  const { router } = briefSetup();
  await router.route("r1", "Sulti, silent mode");
  const ignored = await router.route("r1", "good morning");
  assert.doesNotMatch(ignored.spoken[0] ?? "", /^Good morning, Dennis/);
  const woke = await router.route("r1", "Sulti, good morning");
  assert.match(woke.spoken[0], /^Good morning, Dennis\./);
});

test("if the data can't be gathered it says so instead of going quiet", async () => {
  const { router } = briefSetup({ gather: async () => Promise.reject(new Error("offline")) });
  const r = await router.route("r1", "good morning");
  assert.deepEqual(r.spoken, ["I couldn't pull the briefing together: offline"]);
});

test("a line owed to the next words is not spoken with the briefing, and is said once after it", async () => {
  const { router } = briefSetup({ gather: async () => ({ ...briefData, stories: ["a", "b", "c"] }) });
  router.owe("r1", ["Docs finished."]);
  const brief = await router.route("r1", "good morning");
  assert.doesNotMatch(brief.spoken.join(" "), /Docs finished/);
  await router.route("r1", "never mind");
  const after = await router.route("r1", "Sulti, switch to docs");
  assert.equal(after.spoken.filter((line) => line === "Docs finished.").length, 1);
  assert.equal((await router.route("r1", "Sulti, switch to api")).spoken.includes("Docs finished."), false);
});

test("brief() answers a good morning and its replies without touching the Voice loop; other words are null", async () => {
  const { router, sent } = briefSetup();
  assert.equal(await router.brief(MAC_ROUTER, "run the tests"), null);
  const open = await router.brief(MAC_ROUTER, "good morning");
  assert.match(open?.spoken[0] ?? "", /^Good morning, Dennis\./);
  assert.equal(open?.spoken.at(-1), "Will that be all?");
  assert.equal(await router.brief(MAC_ROUTER, "do it"), null);
  assert.deepEqual(sent, []);
});

test("brief() ends an open briefing on words that are not an answer", async () => {
  const { router } = briefSetup();
  await router.brief(MAC_ROUTER, "good morning");
  assert.equal(await router.brief(MAC_ROUTER, "run the tests please"), null);
  assert.equal(await router.brief(MAC_ROUTER, "yes"), null);
});

test("event() carries a watched reply from a non-target session to every router, one line each", async () => {
  const { router } = setup();
  await pick(router);
  await router.route("r1", "hello");
  const lines = await router.event({ type: "reply", sessionId: "s2", text: "All **done**.", watched: true });
  assert.deepEqual(lines, { r1: ["docs: All done."] });
});

test("event() gives the phone the helper summary, named, for the target's reply", async () => {
  const { router } = setup();
  await pick(router);
  await router.route("r1", "hello");
  const lines = await router.event({ type: "reply", sessionId: "s1", text: "Long reply.\n\nMore detail.", summary: "Two files changed and tests pass." });
  assert.deepEqual(lines, { r1: ["api-refactor: Two files changed and tests pass."] });
});

test("event() gives the phone the helper summary for a watched reply too", async () => {
  const { router } = setup();
  await pick(router);
  await router.route("r1", "hello");
  const lines = await router.event({ type: "reply", sessionId: "s2", text: "Long reply.\n\nMore.", summary: "Docs are done.", watched: true });
  assert.deepEqual(lines, { r1: ["docs: Docs are done."] });
});

test("speaks() is true for any router's own target, so only their replies get a summary", async () => {
  const { router } = setup();
  assert.equal(router.speaks("s1"), false);
  await pick(router);
  assert.equal(router.speaks("s1"), true);
  assert.equal(router.speaks("s2"), false);
  await router.route("r1", "hello");
  assert.equal(router.stateOf("r1")?.session?.id, "s1");
  assert.equal(router.speaks("nobody"), false);
});

test("listening() is true only while a phone router's loop is awake, so a reply the loop would drop can fall back to the Mac", async () => {
  const { router } = setup();
  assert.equal(router.listening(), false);
  await pick(router);
  await router.route("r1", "hello");
  assert.equal(router.listening(), true);
  await router.route("r1", "Sulti, ignore me");
  assert.equal(router.listening(), false);
});

// "Status".
const statusAgents: StatusAgent[] = [
  { id: "s1", title: "api-refactor", status: "running" },
  { id: "s2", title: "docs", status: "running", pendingPermissions: [{}] },
];

function statusSetup(opts: { list?: () => Promise<StatusAgent[]> } = {}) {
  const sent: [string, string][] = [];
  const router = createSultiRouter({
    sessions: async () => ({ list: [api, docs], blocked: [self] }),
    send: async (id, text) => void sent.push([id, text]),
    create: async () => "new1",
    status: opts.list ?? (async () => statusAgents),
  });
  return { router, sent };
}

test("awake, status is answered with the sessions' states and nothing is sent to the target", async () => {
  const { router, sent } = statusSetup();
  await pick(router);
  const r = await router.route("r1", "Sulti, status");
  assert.deepEqual(r.spoken, ["docs needs you. api-refactor is running."]);
  assert.deepEqual(sent, []);
});

test("asleep, status needs the name: without it nothing is said, with it Sulti wakes and answers", async () => {
  const { router } = statusSetup();
  await router.route("r1", "Sulti, silent mode");
  const quiet = await router.route("r1", "status");
  assert.deepEqual(quiet.spoken, []);
  assert.equal(router.stateOf("r1")?.mode, "asleep");
  const named = await router.route("r1", "Sulti, status");
  assert.deepEqual(named.spoken, ["docs needs you. api-refactor is running."]);
  assert.notEqual(router.stateOf("r1")?.mode, "asleep");
});

test("a status list that can't be read is said, not thrown", async () => {
  const { router } = statusSetup({ list: async () => Promise.reject(new Error("offline")) });
  const r = await router.route("r1", "Sulti, status");
  assert.deepEqual(r.spoken, ["I couldn't read the sessions: offline"]);
});

test("a long request that mentions status still goes to the target", async () => {
  const { router, sent } = statusSetup();
  await pick(router);
  await router.route("r1", "the status of the build is red, fix it");
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], "s1");
  assert.ok(sent[0][1].endsWith("the status of the build is red, fix it"));
});

test("a typed one-word message reaches the target, even asleep; spoken one-word is still dropped", async () => {
  const { router, sent } = setup();
  await pick(router);
  await router.route("r1", "Sulti");
  await router.route("r1", "continue");
  assert.deepEqual(sent, []);
  await router.route("r1", "continue", undefined, { typed: true });
  assert.deepEqual(sent, [["s1", "continue"]]);
  const asleep = setup();
  await pick(asleep.router, "r2");
  await asleep.router.route("r2", "continue", undefined, { typed: true });
  assert.deepEqual(asleep.sent, [["s1", "continue"]]);
});

// The Sulti session: when the port returns its id, a router with no target lands on it.
const sultiId = "m1";

test("with a Sulti session, a new router's first utterance goes to it, not a pick prompt", async () => {
  const { router, sent } = setup({ sulti: async () => sultiId });
  const r = await router.route("r1", "how is the factory doing");
  assert.deepEqual(r.spoken, []);
  assert.deepEqual(sent, [[sultiId, "how is the factory doing"]]);
  assert.equal(router.stateOf("r1")?.session?.id, sultiId);
});

test("Sulti is never sent the routing preamble, and another session still gets it once", async () => {
  const { router, raw } = setup({ sulti: async () => sultiId });
  await router.route("r1", "how is the factory doing");
  await router.route("r1", "Sulti, switch to api-refactor");
  await router.route("r1", "run the tests");
  assert.deepEqual(raw, [[sultiId, "how is the factory doing"], ["s1", `${VOICE_ROUTING_PREAMBLE}\n\nrun the tests`]]);
});

test("Sulti's reply is read aloud under its own name, not as a finished notice", async () => {
  const { router } = setup({ sulti: async () => sultiId });
  await router.route("r1", "how is the factory doing");
  const lines = await router.event({ type: "reply", sessionId: sultiId, text: "Two slices are building and none are blocked." });
  assert.deepEqual(lines.r1, ["Sulti: Two slices are building and none are blocked."]);
  assert.deepEqual((await router.event({ type: "notice", kind: "finished", sessionId: sultiId })).r1, []);
});

test("the dashboard router steers Sulti but stays quiet: not listening, not speaking, nothing owed", async () => {
  const { router, sent } = setup({ sulti: async () => sultiId });
  // A typed route wakes the dashboard router and sends the words to Sulti.
  await router.route(DASHBOARD_ROUTER, "how is the factory doing", undefined, { typed: true });
  assert.deepEqual(sent, [[sultiId, "how is the factory doing"]]);
  assert.equal(router.stateOf(DASHBOARD_ROUTER)?.session?.id, sultiId);
  assert.notEqual(router.stateOf(DASHBOARD_ROUTER)?.mode, "asleep");
  // The strip has no phone: it must not count as listening or as the target's speaker.
  assert.equal(router.listening(), false);
  assert.equal(router.speaks(sultiId), false);
  // A Sulti reply gives it no lines, leaves it not speaking, and a phone router still hears it.
  await router.route("r1", "hello there");
  const lines = await router.event({ type: "reply", sessionId: sultiId, text: "All quiet." });
  assert.deepEqual(lines[DASHBOARD_ROUTER] ?? [], []);
  assert.deepEqual(lines.r1, ["Sulti: All quiet."]);
  assert.notEqual(router.stateOf(DASHBOARD_ROUTER)?.mode, "speaking");
  assert.equal(router.speaks(sultiId), true);
});

test("after a reopen (router id changes) talk still goes to the same Sulti id", async () => {
  const { router, sent } = setup({ sulti: async () => sultiId });
  await router.route("r1", "status of the slice");
  await router.route("r2", "and the next one");
  assert.deepEqual(sent, [[sultiId, "status of the slice"], [sultiId, "and the next one"]]);
});

test("'switch to Sulti' after picking another session picks it again, and sends nothing to it", async () => {
  const { router, sent } = setup({ sulti: async () => sultiId });
  await pick(router);
  assert.equal(router.stateOf("r1")?.session?.id, "s1");
  assert.deepEqual((await router.route("r1", "Sulti, switch to Sulti")).spoken, ["Now on Sulti."]);
  assert.equal(router.stateOf("r1")?.session?.id, sultiId);
  assert.deepEqual(sent, []);
});

test("a Sulti session that is also in the session list shows once, as Sulti", async () => {
  const listed: VoiceSession = { id: sultiId, name: "Title from Paseo" };
  const { router } = setup({ sessions: [api, listed, docs], sulti: async () => sultiId });
  await router.route("r1", "hello");
  assert.deepEqual(router.stateOf("r1")?.sessions.map((s) => `${s.id}:${s.name}`), ["s1:api-refactor", "s2:docs", `${sultiId}:Sulti`]);
});

test("a null Sulti leaves routing as today: pick first, nothing said, nothing sent", async () => {
  const { router, sent } = setup({ sulti: async () => null });
  assert.deepEqual(await router.route("r1", "run the tests please"), { spoken: [], note: pickFirstLine(["api-refactor", "docs"]) });
  assert.deepEqual(sent, []);
});

test("a Sulti that rejects is said once, then routing is as today", async () => {
  const { router, sent } = setup({ sulti: async () => Promise.reject(new Error("no model signed in")) });
  const r = await router.route("r1", "run the tests please");
  assert.deepEqual(r.spoken, ["I couldn't start Sulti: no model signed in"]);
  assert.equal(r.note, pickFirstLine(["api-refactor", "docs"]));
  assert.deepEqual(sent, []);
});

// The sessions step drops a target that turns out to be one of Voice's own (blocked) sessions.
test("when the target is dropped, the next utterance says it is now on Sulti before sending", async () => {
  let list = [api, docs];
  let blocked: VoiceSession[] = [];
  const sent: [string, string][] = [];
  const router = createSultiRouter({
    sessions: async () => ({ list, blocked }),
    send: async (id, text) => void sent.push([id, text.replace(`${VOICE_ROUTING_PREAMBLE}\n\n`, "")]),
    create: async () => "new1",
    sulti: async () => sultiId,
  });
  await pick(router);
  assert.equal(router.stateOf("r1")?.session?.id, "s1");
  list = [docs];
  blocked = [api];
  const r = await router.route("r1", "any news");
  assert.deepEqual(r.spoken, ["Now on Sulti."]);
  assert.deepEqual(sent.at(-1), [sultiId, "any news"]);
});

test("when the Sulti session is replaced, the next utterance goes to the new id", async () => {
  // Arrange: the router lands on m1, then it dies and the port hands back m2.
  let current = sultiId;
  const { router, sent } = setup({ sulti: async () => current });
  await router.route("r1", "status of the slice");
  current = "m2";
  // Act
  const r = await router.route("r1", "and the next one");
  // Assert: said once, and sent to the new id, not the dead one
  assert.deepEqual(r.spoken, ["Now on Sulti."]);
  assert.deepEqual(sent, [[sultiId, "status of the slice"], ["m2", "and the next one"]]);
  assert.equal(router.stateOf("r1")?.session?.id, "m2");
});

test("merge, delete and interrupt are handled for Sulti as for any target: the loop's rule is unchanged", async () => {
  const toSulti = setup({ sulti: async () => sultiId });
  const toApi = setup();
  await pick(toApi.router);
  const words = ["let's stop the build here", "don't interrupt the run", "merge it", "delete the branch"];
  for (const text of words) {
    const viaSulti = await toSulti.router.route("r1", text);
    const viaApi = await toApi.router.route("r1", text);
    assert.deepEqual(viaSulti.spoken, viaApi.spoken);
    assert.equal(toSulti.router.stateOf("r1")?.mode, toApi.router.stateOf("r1")?.mode);
  }
  assert.deepEqual(toSulti.sent, words.map((text) => [sultiId, text]));
});

test("status, the briefing and a switch never steer Sulti", async () => {
  const { router, sent } = (() => {
    const sent: [string, string][] = [];
    const router = createSultiRouter({
      sessions: async () => ({ list: [api, docs], blocked: [self] }),
      send: async (id, text) => void sent.push([id, text]),
      create: async () => "new1",
      sulti: async () => sultiId,
      status: async () => statusAgents,
      brief: { gather: async () => briefData },
    });
    return { router, sent };
  })();
  const status = await router.route("r1", "Sulti, status");
  assert.match(status.spoken[0] ?? "", /docs needs you/);
  assert.ok((await router.route("r1", "Sulti, good morning")).spoken.length > 0);
  await router.route("r1", "Sulti, switch to docs");
  assert.deepEqual(sent, []);
});

test("a new session spoken while on Sulti is created beside it, Sulti is steered by nothing, and the new one becomes the target", async () => {
  const { router, raw, created } = setup({ sulti: async () => sultiId });
  await router.route("r1", "Sulti, switch to Sulti");
  await router.route("r1", "start a new session");
  assert.deepEqual(created, [{ id: sultiId, name: "Sulti" }]);
  assert.equal(router.stateOf("r1")?.session?.id, "new1");
  await router.route("r1", "run the tests");
  assert.deepEqual(raw, [["new1", "run the tests"]]);
});

// The factory status reporter: "where are we" is answered from the factory's files by a cheap one-shot, never by Sulti.
function reporterSetup(factoryStatus: () => Promise<{ answer: string } | { unavailable: string } | null>) {
  const sent: [string, string][] = [];
  let sultiCalls = 0;
  const router = createSultiRouter({
    sessions: async () => ({ list: [api, docs], blocked: [self] }),
    send: async (id, text) => void sent.push([id, text.replace(`${VOICE_ROUTING_PREAMBLE}\n\n`, "")]),
    create: async () => "new1",
    status: async () => statusAgents,
    sulti: async () => {
      sultiCalls += 1;
      return sultiId;
    },
    factoryStatus,
  });
  return { router, sent, sultiCalls: () => sultiCalls };
}

test("'where are we' is spoken from the reporter, and Sulti is neither woken nor sent anything", async () => {
  const { router, sent, sultiCalls } = reporterSetup(async () => ({ answer: "Two slices; s1 is building." }));
  const r = await router.route("r1", "Sulti, where are we?");
  assert.deepEqual(r.spoken, ["Two slices; s1 is building."]);
  assert.equal(sultiCalls(), 0);
  assert.deepEqual(sent, []);
});

test("when the reporter is unavailable the words go to Sulti, with a note that says why", async () => {
  const { router, sent, sultiCalls } = reporterSetup(async () => ({ unavailable: "Claude Code is not signed in." }));
  const r = await router.route("r1", "where are we");
  assert.equal(sultiCalls(), 1);
  assert.deepEqual(sent, [[sultiId, "where are we"]]);
  assert.match(r.note ?? "", /Claude Code is not signed in\./);
});

test("the unavailable note names the session the words actually went to, not Sulti", async () => {
  const { router, sent } = reporterSetup(async () => ({ unavailable: "offline" }));
  await router.route("r1", "Sulti, switch to docs");
  const r = await router.route("r1", "where are we");
  assert.deepEqual(sent, [["s2", "where are we"]]);
  assert.match(r.note ?? "", /this went to docs/);
  assert.doesNotMatch(r.note ?? "", /Sulti/);
});

test("plain 'status' with the reporter unavailable keeps the free session line and says why", async () => {
  const { router, sent, sultiCalls } = reporterSetup(async () => ({ unavailable: "offline" }));
  const r = await router.route("r1", "Sulti, status");
  assert.match(r.spoken[0] ?? "", /docs needs you/);
  assert.match(r.note ?? "", /offline/);
  assert.equal(sultiCalls(), 0);
  assert.deepEqual(sent, []);
});

test("a reporter that throws is treated as unavailable", async () => {
  const { router, sent } = reporterSetup(async () => Promise.reject(new Error("disk gone")));
  const r = await router.route("r1", "what's the factory doing");
  assert.deepEqual(sent, [[sultiId, "what's the factory doing"]]);
  assert.match(r.note ?? "", /disk gone/);
});

test("with no factory the reporter says null and 'where are we' routes as before", async () => {
  const { router, sent } = reporterSetup(async () => null);
  await router.route("r1", "where are we");
  assert.deepEqual(sent, [[sultiId, "where are we"]]);
});

test("plain 'status' goes to the reporter when a factory exists, and to the session line when it doesn't", async () => {
  const withFactory = reporterSetup(async () => ({ answer: "s1 is building." }));
  assert.deepEqual((await withFactory.router.route("r1", "Sulti, status")).spoken, ["s1 is building."]);
  assert.equal(withFactory.sultiCalls(), 0);

  const without = reporterSetup(async () => null);
  const r = await without.router.route("r1", "Sulti, status");
  assert.match(r.spoken[0] ?? "", /docs needs you/);
  assert.deepEqual(without.sent, []);
});

test("asleep, the reporter answers only to the name, like status", async () => {
  let asked = 0;
  const { router } = reporterSetup(async () => {
    asked += 1;
    return { answer: "s1 is building." };
  });
  await router.route("r1", "Sulti, silent mode");
  const quiet = await router.route("r1", "where are we");
  assert.deepEqual(quiet.spoken, []);
  assert.equal(asked, 0);
  const named = await router.route("r1", "Sulti, where are we");
  assert.deepEqual(named.spoken, ["s1 is building."]);
  assert.notEqual(router.stateOf("r1")?.mode, "asleep");
});
