import assert from "node:assert/strict";
import { test } from "node:test";
import { CHATTERBOX_BUDGET_MS, createSpeaker, PLAYBACK_RATE, resolveReferenceClip, speedUp, type SpeakerWorker } from "./voice-speaker";
import { createSpeakerWorkers, type WorkerChild } from "./voice-speaker-workers";

function fake(over: { clip?: string; chatReady?: boolean; kokoReady?: boolean; chatCostMs?: number; chatHangs?: boolean } = {}) {
  let time = 0;
  const calls: string[] = [];
  const chatterbox: SpeakerWorker = {
    ready: () => over.chatReady ?? true,
    render: async (text, clip) => {
      calls.push(`chatterbox:${text}:${clip}`);
      if (over.chatHangs) return new Promise<string>(() => {});
      time += over.chatCostMs ?? 100;
      return `C(${text})`;
    },
  };
  const kokoro: SpeakerWorker = {
    ready: () => over.kokoReady ?? true,
    render: async (text) => {
      calls.push(`kokoro:${text}`);
      return `K(${text})`;
    },
  };
  const speak = createSpeaker({
    chatterbox,
    kokoro,
    readClip: () => ("clip" in over ? over.clip : "/clips/me.wav"),
    now: () => time,
    sleep: async () => {},
  });
  return { speak, calls };
}

test("no reference clip uses Kokoro", async () => {
  const { speak, calls } = fake({ clip: undefined });
  assert.deepEqual(await speak({ text: "Hi.", replyId: "r1" }), { audio: "K(Hi.)", engine: "kokoro" });
  assert.deepEqual(calls, ["kokoro:Hi."]);
});

test("Chatterbox not ready uses Kokoro", async () => {
  const { speak } = fake({ chatReady: false });
  assert.deepEqual(await speak({ text: "Hi.", replyId: "r1" }), { audio: "K(Hi.)", engine: "kokoro" });
});

test("Chatterbox is used when it is ready and there is a clip", async () => {
  const { speak, calls } = fake();
  assert.deepEqual(await speak({ text: "Hi.", replyId: "r1" }), { audio: "C(Hi.)", engine: "chatterbox" });
  assert.deepEqual(calls, ["chatterbox:Hi.:/clips/me.wav"]);
});

test("a sentence over the budget keeps its audio, then the rest of that reply uses Kokoro", async () => {
  const { speak } = fake({ chatCostMs: CHATTERBOX_BUDGET_MS + 1 });
  assert.equal((await speak({ text: "One.", replyId: "r1" })).engine, "chatterbox");
  assert.equal((await speak({ text: "Two.", replyId: "r1" })).engine, "kokoro");
  assert.equal((await speak({ text: "Three.", replyId: "r2" })).engine, "chatterbox");
});

test("a Chatterbox sentence that times out is re-rendered on Kokoro", async () => {
  const { speak } = fake({ chatHangs: true });
  assert.deepEqual(await speak({ text: "One.", replyId: "r1" }), { audio: "K(One.)", engine: "kokoro" });
  assert.equal((await speak({ text: "Two.", replyId: "r1" })).engine, "kokoro");
});

test("both workers loading answers loading without audio", async () => {
  const { speak, calls } = fake({ chatReady: false, kokoReady: false });
  assert.deepEqual(await speak({ text: "Hi.", replyId: "r1" }), { audio: "", engine: "loading" });
  assert.deepEqual(calls, []);
});

// Fake child process: records what the manager writes, and lets the test send lines or exit.
function fakeSpawn(opts: { fail?: Error; hold?: boolean; readClip?: () => string | undefined } = {}) {
  const children: { args: string[]; written: Record<string, unknown>[]; killed: boolean; say: (m: object) => void; exit: () => void }[] = [];
  const warnings: string[] = [];
  const spawn = (cmd: string, args: string[]): WorkerChild => {
    if (opts.fail) throw opts.fail;
    let onLine = (_line: string) => {};
    let onExit = (_error?: Error) => {};
    const child = {
      args: [cmd, ...args],
      written: [] as Record<string, unknown>[],
      killed: false,
      say: (m: object) => onLine(JSON.stringify(m)),
      exit: () => onExit(),
    };
    children.push(child);
    return {
      write: (line) => {
        const msg = JSON.parse(line) as Record<string, unknown>;
        child.written.push(msg);
        if (msg.op === "render" && !opts.hold) child.say({ id: msg.id, audio: `W(${msg.text})` });
        if (msg.op === "prepare") child.say({ id: msg.id, prepared: true });
      },
      onLine: (cb) => (onLine = cb),
      onExit: (cb) => (onExit = cb),
      kill: () => {
        child.killed = true;
      },
    };
  };
  const workers = createSpeakerWorkers({ spawn, warn: (m) => warnings.push(m), readClip: opts.readClip });
  return { workers, children, warnings };
}

test("workers report not ready while loading, then ready", () => {
  const { workers, children } = fakeSpawn();
  workers.start();
  assert.equal(workers.chatterbox.ready(), false);
  assert.equal(workers.kokoro.ready(), false);
  children[0].say({ ready: true });
  assert.equal(workers.chatterbox.ready(), true);
  assert.equal(workers.kokoro.ready(), false);
});

test("the voice is prepared once per clip, and again when the clip changes", async () => {
  const { workers, children } = fakeSpawn();
  workers.start();
  children[0].say({ ready: true });
  await workers.chatterbox.render("One.", "/a.wav");
  await workers.chatterbox.render("Two.", "/a.wav");
  await workers.chatterbox.render("Three.", "/b.wav");
  const ops = children[0].written.map((m) => (m.op === "prepare" ? `prepare:${m.clip}` : "render"));
  assert.deepEqual(ops, ["prepare:/a.wav", "render", "render", "prepare:/b.wav", "render"]);
});

test("an exited worker is restarted and reports not ready until it is loaded again", async () => {
  const { workers, children } = fakeSpawn();
  workers.start();
  children[1].say({ ready: true });
  assert.equal(workers.kokoro.ready(), true);
  children[1].exit();
  assert.equal(workers.kokoro.ready(), false);
  assert.equal(children.length, 3);
  children[2].say({ ready: true });
  assert.equal(await workers.kokoro.render("Hi."), "W(Hi.)");
});

test("a render in flight when the worker exits is rejected", async () => {
  const { workers, children } = fakeSpawn({ hold: true });
  workers.start();
  children[1].say({ ready: true });
  const pending = workers.kokoro.render("Hi.");
  children[1].exit();
  await assert.rejects(pending);
});

test("stop kills both workers and does not restart them", () => {
  const { workers, children } = fakeSpawn();
  workers.start();
  workers.stop();
  assert.deepEqual(children.map((c) => c.killed), [true, true]);
  children[0].exit();
  assert.equal(children.length, 2);
});

test("a missing uv keeps the workers not ready and warns what is missing", () => {
  const { workers, warnings } = fakeSpawn({ fail: new Error("spawn uv ENOENT") });
  workers.start();
  assert.equal(workers.chatterbox.ready(), false);
  assert.equal(workers.kokoro.ready(), false);
  assert.ok(warnings.some((w) => w.includes("uv")));
});

test("the speaker remembers only the last 50 replies that fell back to Kokoro", async () => {
  const { speak, calls } = fake({ chatHangs: true });
  for (let i = 0; i < 51; i++) await speak({ text: "x", replyId: `r${i}` });
  calls.length = 0;
  await speak({ text: "again", replyId: "r0" });
  assert.equal(calls[0], "chatterbox:again:/clips/me.wav");
});

test("warm at launch: the cloned voice is prepared as soon as the model is up, before any sentence", async () => {
  const { workers, children } = fakeSpawn({ readClip: () => "/me.wav" });
  workers.start();
  assert.equal(children[0].written.length, 0);
  children[0].say({ ready: true });
  assert.deepEqual(children[0].written.map((m) => `${m.op}:${m.clip}`), ["prepare:/me.wav"]);
  await workers.chatterbox.render("One.", "/me.wav");
  assert.deepEqual(children[0].written.map((m) => m.op), ["prepare", "render"]);
});

test("warm at launch does nothing without a clip, and the first sentence answers loading rather than hanging", async () => {
  const { workers, children } = fakeSpawn({ readClip: () => undefined });
  workers.start();
  await assert.rejects(workers.chatterbox.render("One.", undefined), /still loading/);
  children[0].say({ ready: true });
  assert.equal(children[0].written.length, 0);
});

function wavBase64(sampleRate: number) {
  const wav = Buffer.alloc(48);
  wav.write("RIFF", 0, "ascii");
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  return wav.toString("base64");
}

test("every line is played 1.1x faster: the WAV's sample rate is raised", () => {
  assert.equal(PLAYBACK_RATE, 1.1);
  const sped = Buffer.from(speedUp(wavBase64(24000)), "base64");
  assert.equal(sped.readUInt32LE(24), 26400);
  assert.equal(sped.readUInt32LE(28), 52800);
});

test("audio that is not a WAV is returned as it came", () => {
  assert.equal(speedUp("not-a-wav"), "not-a-wav");
});

test("the speaker returns Chatterbox and Kokoro audio at 1.1x", async () => {
  const worker = (ready: boolean): SpeakerWorker => ({ ready: () => ready, render: async () => wavBase64(24000) });
  for (const [clip, expected] of [["/me.wav", "chatterbox"], [undefined, "kokoro"]] as const) {
    const speak = createSpeaker({ chatterbox: worker(true), kokoro: worker(true), readClip: () => clip, now: () => 0, sleep: () => new Promise<void>(() => undefined) });
    const result = await speak({ text: "Hi.", replyId: "r" });
    assert.equal(result.engine, expected);
    assert.equal(Buffer.from(result.audio, "base64").readUInt32LE(24), 26400);
  }
});

test("the reference clip is the setting, else the default file when it exists, else none", () => {
  assert.equal(resolveReferenceClip("/mine.wav", () => false, "/default.wav"), "/mine.wav");
  assert.equal(resolveReferenceClip("", (path) => path === "/default.wav", "/default.wav"), "/default.wav");
  assert.equal(resolveReferenceClip("", () => false, "/default.wav"), undefined);
});
