import assert from "node:assert/strict";
import { test } from "node:test";
import { VOICE_HELPER_SYSTEM_PROMPT, VOICE_VOCABULARY, helperPrompt, parseHelperReply, passThrough, withFallback } from "./voice-interpreter";
import type { InterpretContext, Interpreter } from "./voice-interpreter";
import type { InterpretResult, VoiceSession } from "./voice-loop";

const sessions: VoiceSession[] = [
  { id: "s1", name: "api-refactor" },
  { id: "s2", name: "Docs" },
];
const drop = { type: "drop" };

// Cycle 1
test("the four JSON shapes map to interpret results", () => {
  assert.deepEqual(parseHelperReply('{"action":"send","text":"run the tests"}', sessions), { type: "send", text: "run the tests" });
  assert.deepEqual(parseHelperReply('{"action":"confirm","text":"merge it"}', sessions), { type: "send", text: "merge it" });
  assert.deepEqual(parseHelperReply('{"action":"switch","session":"api-refactor"}', sessions), { type: "switch", name: "api-refactor" });
  assert.deepEqual(parseHelperReply('{"action":"drop"}', sessions), drop);
});

test("a fence-wrapped object is unwrapped and parsed normally", () => {
  assert.deepEqual(parseHelperReply('```json\n{"action":"send","text":"hi"}\n```', sessions), { type: "send", text: "hi" });
  assert.deepEqual(parseHelperReply('```\n{"action":"drop"}\n```', sessions), drop);
  assert.deepEqual(parseHelperReply('  ```json\n{"action":"switch","session":"docs"}\n```  ', sessions), { type: "switch", name: "docs" });
});

test("a switch name is passed through loosely for the loop to match", () => {
  assert.deepEqual(parseHelperReply('{"action":"switch","session":"the planning one"}', sessions), { type: "switch", name: "the planning one" });
  assert.deepEqual(parseHelperReply('{"action":"switch","session":"billing"}', sessions), { type: "switch", name: "billing" });
});

test("sendTo carries the loose session name and the request in full", () => {
  assert.deepEqual(parseHelperReply('{"action":"sendTo","session":"planning","text":"add the retry tests"}', sessions), {
    type: "sendTo",
    session: "planning",
    text: "add the retry tests",
  });
});

test("a confirm reply is read as a send and the helper never yields a confirm", () => {
  assert.deepEqual(parseHelperReply('{"action":"confirm","text":"merge it"}', sessions), { type: "send", text: "merge it" });
});

test("anything that is not a well-formed reply drops", () => {
  const replies: (string | null)[] = [
    null,
    "",
    "   ",
    "Sure, I will send that.",
    "[1,2]",
    "null",
    '{"action":"send"}',
    '{"action":"confirm"}',
    '{"action":"send","text":""}',
    '{"action":"send","text":42}',
    '{"action":"switch"}',
    '{"action":"switch","session":7}',
    '{"action":"sendTo","text":"x"}',
    '{"action":"sendTo","session":"planning"}',
    '{"action":"sendTo","session":"","text":"x"}',
    '{"action":"sendTo","session":7,"text":"x"}',
    '{"action":"explode","text":"x"}',
    '{"action":5}',
    '{"text":"no action"}',
    '{"action":"send","text":"x"',
  ];
  for (const reply of replies) assert.deepEqual(parseHelperReply(reply, sessions), drop, String(reply));
});

// Cycle 2
const ctx = (over: Partial<InterpretContext> = {}): InterpretContext => ({
  transcript: "merge England",
  targetTitle: "Fix the login bug",
  recent: [],
  sessions,
  ...over,
});

test("the prompt carries the transcript, title, vocabulary and session names", () => {
  const prompt = helperPrompt(ctx());
  assert.ok(prompt.includes("merge England"));
  assert.ok(prompt.includes("Fix the login bug"));
  for (const word of VOICE_VOCABULARY) assert.ok(prompt.includes(word), word);
  for (const word of ["merge", "Orchestrator", "Paseo", "Jarvis", "S1", "S3"]) assert.ok(prompt.includes(word), word);
  assert.ok(prompt.includes("api-refactor"));
  assert.ok(prompt.includes("Docs"));
});

test("a missing target title is handled", () => {
  assert.ok(!helperPrompt(ctx({ targetTitle: null })).includes("null"));
});

test("only the last 4 recent messages go in, each cut to 300 characters", () => {
  const recent = Array.from({ length: 6 }, (_, i) => ({
    role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
    text: `msg${i}-` + "x".repeat(400),
  }));
  const prompt = helperPrompt(ctx({ recent }));
  assert.ok(!prompt.includes("msg0-") && !prompt.includes("msg1-"));
  for (const i of [2, 3, 4, 5]) assert.ok(prompt.includes(`msg${i}-`), `msg${i}`);
  assert.ok(prompt.includes("x".repeat(290)));
  assert.ok(!prompt.includes("x".repeat(300)), "cut to 300 characters including the prefix");
  assert.ok(/user: msg2-/.test(prompt) && /assistant: msg3-/.test(prompt));
});

test("the system prompt lists send, sendTo, switch and drop, the JSON shape and the examples, with no confirm", () => {
  for (const action of ["send", "sendTo", "switch", "drop"]) assert.ok(VOICE_HELPER_SYSTEM_PROMPT.includes(`"${action}"`), action);
  assert.ok(!VOICE_HELPER_SYSTEM_PROMPT.includes("confirm"));
  assert.ok(VOICE_HELPER_SYSTEM_PROMPT.includes('{"action":"send"|"sendTo"|"switch"|"drop","text"?:...,"session"?:...}'));
  assert.ok(/only that JSON/i.test(VOICE_HELPER_SYSTEM_PROMPT));
  for (const example of ["This day", "merge England", "merge it", "switch to the review session", "send that to the planning one"]) assert.ok(VOICE_HELPER_SYSTEM_PROMPT.includes(example), example);
  assert.ok(/recent messages/i.test(VOICE_HELPER_SYSTEM_PROMPT));
  assert.ok(/in full/i.test(VOICE_HELPER_SYSTEM_PROMPT));
  assert.ok(/switch only/i.test(VOICE_HELPER_SYSTEM_PROMPT));
});

test("passThrough sends the text as heard", async () => {
  assert.deepEqual(await passThrough.interpret("hello there"), { type: "send", text: "hello there" });
});

// Cycle 3
const fakeTimer = () => {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  return {
    timers,
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (handle: unknown) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    fire: () => timers.forEach((t) => !t.cleared && t.fn()),
  };
};
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
const helperSend = { type: "send", text: "cleaned" } as const;
const tick = () => new Promise<void>((r) => setImmediate(r));

test("a primary answer before the timeout wins and clears the timer", async () => {
  const clock = fakeTimer();
  const primary: Interpreter = { interpret: async () => helperSend };
  const out = await withFallback(primary, passThrough, clock).interpret("raw");
  assert.deepEqual(out, { result: helperSend, via: "helper" });
  assert.equal(clock.timers.length, 1);
  assert.equal(clock.timers[0].ms, 3000);
  assert.equal(clock.timers[0].cleared, true);
});

test("a slow primary falls back with reason timeout, and its late answer is harmless", async () => {
  const clock = fakeTimer();
  const slow = deferred<InterpretResult>();
  const out = withFallback({ interpret: () => slow.promise }, passThrough, { ...clock, timeoutMs: 500 }).interpret("raw");
  assert.equal(clock.timers[0].ms, 500);
  clock.fire();
  assert.deepEqual(await out, { result: { type: "send", text: "raw" }, via: "passThrough", reason: "timeout" });
  assert.equal(clock.timers[0].cleared, true);
  slow.resolve(helperSend);
  await tick();
});

test("a rejecting primary falls back with reason error and clears the timer", async () => {
  const clock = fakeTimer();
  const primary: Interpreter = { interpret: () => Promise.reject(new Error("boom")) };
  const out = await withFallback(primary, passThrough, clock).interpret("raw");
  assert.deepEqual(out, { result: { type: "send", text: "raw" }, via: "passThrough", reason: "error" });
  assert.equal(clock.timers[0].cleared, true);
});

test("a synchronous throw counts as an error", async () => {
  const clock = fakeTimer();
  const primary: Interpreter = {
    interpret: () => {
      throw new Error("sync");
    },
  };
  const out = await withFallback(primary, passThrough, clock).interpret("raw");
  assert.equal(out.via, "passThrough");
  assert.equal(out.reason, "error");
  assert.equal(clock.timers[0].cleared, true);
});

test("a rejection after the timeout does not become an unhandled rejection", async () => {
  const clock = fakeTimer();
  const slow = deferred<InterpretResult>();
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const out = withFallback({ interpret: () => slow.promise }, passThrough, clock).interpret("raw");
    clock.fire();
    await out;
    slow.reject(new Error("late"));
    await tick();
    await tick();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test("the context is passed through to both interpreters", async () => {
  const clock = fakeTimer();
  const seen: (InterpretContext | undefined)[] = [];
  const spy: Interpreter = {
    interpret: async (_t, c) => {
      seen.push(c);
      throw new Error("x");
    },
  };
  const c = ctx();
  const fb: Interpreter = { interpret: async (t, cc) => (seen.push(cc), { type: "send", text: t }) };
  await withFallback(spy, fb, clock).interpret("raw", c);
  assert.deepEqual(seen, [c, c]);
});

test("real timers are the default and the default timeout is 3 seconds", async () => {
  const out = await withFallback({ interpret: async () => helperSend }, passThrough).interpret("raw");
  assert.equal(out.via, "helper");
});
