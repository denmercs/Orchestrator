// Speaks on the Mac itself, for Speak replies and Jarvis: sentence by sentence through the one Speaker, so it is the same
// voice as the drawer's. Players are ports (afplay and `say` in real life), so tests need neither audio nor a Mac.
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
  /** macOS `say`, for when neither voice can render. */
  say: (text: string) => Playing;
};

export type LocalSpeakResult = "ended" | "stopped";

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
      // Both voices still loading or failed: macOS `say`, so a reply is never silent.
      await playOne(answer.engine === "loading" ? ports.say(sentences[i]) : ports.play(answer.audio), mine);
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
    say: (text) => exec("say", [text]),
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

