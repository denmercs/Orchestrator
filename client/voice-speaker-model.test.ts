import assert from "node:assert/strict";
import { test } from "node:test";
import { createSentencePlayer, splitSentences } from "./voice-speaker-model";

type Render = { audio: string; engine: "chatterbox" | "kokoro" | "loading" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

test("splitSentences breaks on sentence ends and keeps each piece within the speak cap", () => {
  assert.deepEqual(splitSentences("Hi there. How are you? Fine!"), ["Hi there.", "How are you?", "Fine!"]);
  assert.deepEqual(splitSentences("  \n "), []);
  const long = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
  const pieces = splitSentences(long);
  assert.ok(pieces.length > 1);
  assert.ok(pieces.every((p) => p.length > 0 && p.length <= 400));
  assert.equal(pieces.join(" "), long);
});

test("fetches sentence n+1 while n plays, and plays in order", async () => {
  const log: string[] = [];
  const firstPlay = deferred<void>();
  const player = createSentencePlayer({
    render: async (text) => {
      log.push(`render ${text}`);
      return { audio: `audio:${text}`, engine: "kokoro" } satisfies Render;
    },
    play: async (audio) => {
      log.push(`play ${audio}`);
      if (audio === "audio:One.") await firstPlay.promise;
    },
  });
  const done = player.speak("One. Two. Three.", "r1");
  await tick();
  assert.deepEqual(log, ["render One.", "render Two.", "play audio:One."]);
  firstPlay.resolve();
  assert.equal(await done, "ended");
  assert.deepEqual(log.filter((l) => l.startsWith("play")), ["play audio:One.", "play audio:Two.", "play audio:Three."]);
});

test("stop() resolves stopped, plays nothing more and drops late answers", async () => {
  const late = deferred<Render>();
  const played: string[] = [];
  const player = createSentencePlayer({
    render: (text) => (text === "One." ? Promise.resolve({ audio: "a1", engine: "kokoro" as const }) : late.promise),
    play: async (audio) => {
      played.push(audio);
    },
  });
  const done = player.speak("One. Two.", "r1");
  await tick();
  player.stop();
  assert.equal(await done, "stopped");
  late.resolve({ audio: "a2", engine: "kokoro" });
  await tick();
  assert.deepEqual(played, ["a1"]);
});

test("stop() during playback resolves stopped without waiting for the sentence to finish", async () => {
  const never = new Promise<void>(() => {});
  const player = createSentencePlayer({
    render: async () => ({ audio: "a", engine: "kokoro" as const }),
    play: () => never,
  });
  const done = player.speak("One. Two.", "r1");
  await tick();
  player.stop();
  assert.equal(await done, "stopped");
});

test("a loading engine answer plays nothing and resolves ended", async () => {
  // The Speaker's workers are still starting: there is nothing to play, and retrying would hang the line, so the line
  // is dropped quietly and the loop moves on ("ended").
  const played: string[] = [];
  const player = createSentencePlayer({
    render: async () => ({ audio: "", engine: "loading" as const }),
    play: async (audio) => {
      played.push(audio);
    },
  });
  assert.equal(await player.speak("One. Two.", "r1"), "ended");
  assert.deepEqual(played, []);
});
