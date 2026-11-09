// Speaks on the Mac itself, for Speak replies and Sulti: sentence by sentence through the one Speaker, so it is the same
// voice as the drawer's. Players are ports (afplay in real life), so tests need neither audio nor a Mac. There is no
// fallback voice: macOS `say` sounded robotic, so a Speaker that is loading or failed says nothing and `speak` reports it.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitSentences } from "../shared/voice-sentences";
import type { SpeakResult } from "./voice-speaker";

export type Playing = { done: Promise<void>; kill: () => void };
export type LocalPorts = {
  /** The server Speaker: renders one sentence to base64 WAV. */
  render: (input: { text: string; replyId: string }) => Promise<SpeakResult>;
  /** Plays a base64 WAV file. */
  play: (audio: string) => Playing;
};

/** "unavailable": the Speaker could not render the first sentence, so nothing was said and the caller may use another voice. */
export type LocalSpeakResult = "ended" | "stopped" | "unavailable";

export function createLocalVoice(ports: LocalPorts) {
  // `hush` bumps the epoch: anything queued or rendered under an older one is dropped, never played.
  let epoch = 0;
  let nextReply = 1;
  let current: Playing | undefined;
  let tail: Promise<unknown> = Promise.resolve();

  const hushed = (mine: number) => mine !== epoch;
  const playOne = async (playing: Playing, mine: number) => {
    if (hushed(mine)) return playing.kill();
    current = playing;
    await playing.done.catch(() => undefined);
    if (current === playing) current = undefined;
  };

  async function run(text: string, mine: number): Promise<LocalSpeakResult> {
    const replyId = `local-${nextReply++}`;
    const sentences = splitSentences(text);
    const render = (i: number) => ports.render({ text: sentences[i], replyId }).catch(() => ({ audio: "", engine: "loading" as const }));
    let next = sentences.length ? render(0) : undefined;
    for (let i = 0; i < sentences.length; i++) {
      const answer = await next!;
      next = i + 1 < sentences.length ? render(i + 1) : undefined;
      if (hushed(mine)) return "stopped";
      // Still loading or failed: say nothing more. Nothing played yet means the caller can try another voice.
      if (answer.engine === "loading") return i === 0 ? "unavailable" : "ended";
      await playOne(ports.play(answer.audio), mine);
      if (hushed(mine)) return "stopped";
    }
    return "ended";
  }

  return {
    /** Queues the text behind what is already being said; resolves when it has been said, or cut off. */
    speak(text: string): Promise<LocalSpeakResult> {
      const mine = epoch;
      const done = tail.then(() => (hushed(mine) ? "stopped" : run(text, mine)));
      tail = done.catch(() => undefined);
      return done as Promise<LocalSpeakResult>;
    },
    /** Stop talking now: cut the sentence being played and empty the queue. */
    hush() {
      epoch += 1;
      current?.kill();
      current = undefined;
    },
  };
}

export function realLocalPorts(render: LocalPorts["render"]): LocalPorts {
  const exec = (cmd: string, args: string[]): Playing => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    const done = new Promise<void>((resolve) => {
      child.on("error", () => resolve());
      child.on("exit", () => resolve());
    });
    return { done, kill: () => void child.kill() };
  };
  return {
    render,
    play(audio) {
      let killed = false;
      let child: Playing | undefined;
      let dir: string | undefined;
      const done = (async () => {
        dir = await mkdtemp(join(tmpdir(), "orchestrator-voice-"));
        const file = join(dir, "line.wav");
        await writeFile(file, Buffer.from(audio, "base64"));
        if (!killed) {
          child = exec("afplay", ["-q", "1", file]);
          await child.done;
        }
      })()
        .catch(() => undefined)
        .finally(() => void (dir && rm(dir, { recursive: true, force: true }).catch(() => undefined)));
      return {
        done,
        kill: () => {
          killed = true;
          child?.kill();
        },
      };
    },
  };
}

