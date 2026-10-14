import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalVoice, type LocalPorts, type Playing } from "./voice-local";

// Each played or said sentence stays "playing" until the test finishes it, so hush can cut it off.
function setup(engine: "chatterbox" | "kokoro" | "loading" = "chatterbox") {
  const log: string[] = [];
  const playing: { finish: () => void; killed: boolean }[] = [];
  const start = (label: string): Playing => {
    let finish = () => {};
    const done = new Promise<void>((resolve) => (finish = resolve));
    const entry = { finish, killed: false };
    playing.push(entry);
    log.push(label);
    return {
      done,
      kill: () => {
        entry.killed = true;
        finish();
      },
    };
  };
  const ports: LocalPorts = {
    render: async ({ text }) => ({ audio: engine === "loading" ? "" : `audio:${text}`, engine }),
    play: (audio) => start(audio),
    say: (text) => start(`say:${text}`),
  };
  const tick = () => new Promise((r) => setTimeout(r, 5));
  return { voice: createLocalVoice(ports), log, playing, tick };
}

test("a reply is played sentence by sentence in order", async () => {
  const { voice, log, playing, tick } = setup();
  const done = voice.speak("One. Two.");
  await tick();
  assert.deepEqual(log, ["audio:One."]);
  playing[0].finish();
  await tick();
  assert.deepEqual(log, ["audio:One.", "audio:Two."]);
  playing[1].finish();
  assert.equal(await done, "ended");
});

test("hush cuts the sentence being played and empties the queue", async () => {
  const { voice, log, playing, tick } = setup();
  const first = voice.speak("One. Two.");
  const second = voice.speak("Three.");
  await tick();
  voice.hush();
  assert.equal(playing[0].killed, true);
  assert.equal(await first, "stopped");
  assert.equal(await second, "stopped");
  await tick();
  assert.deepEqual(log, ["audio:One."]);
});

test("speaking after a hush works again", async () => {
  const { voice, log, playing, tick } = setup();
  const stopped = voice.speak("One.");
  await tick();
  voice.hush();
  await stopped;
  const next = voice.speak("Fresh.");
  await tick();
  assert.deepEqual(log, ["audio:One.", "audio:Fresh."]);
  playing[1].finish();
  assert.equal(await next, "ended");
});

test("a second reply waits for the first: the Mac never speaks two at once", async () => {
  const { voice, log, playing, tick } = setup();
  void voice.speak("First.");
  void voice.speak("Second.");
  await tick();
  assert.deepEqual(log, ["audio:First."]);
  playing[0].finish();
  await tick();
  assert.deepEqual(log, ["audio:First.", "audio:Second."]);
});

test("with both voices unavailable, macOS say speaks the sentence", async () => {
  const { voice, log, playing, tick } = setup("loading");
  const done = voice.speak("Still loading.");
  await tick();
  assert.deepEqual(log, ["say:Still loading."]);
  playing[0].finish();
  assert.equal(await done, "ended");
});

test("a render that fails falls back to macOS say", async () => {
  const log: string[] = [];
  const voice = createLocalVoice({
    render: async () => {
      throw new Error("worker exited");
    },
    play: () => ({ done: Promise.resolve(), kill: () => undefined }),
    say: (text) => (log.push(text), { done: Promise.resolve(), kill: () => undefined }),
  });
  assert.equal(await voice.speak("Hi there."), "ended");
  assert.deepEqual(log, ["Hi there."]);
});
