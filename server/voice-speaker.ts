import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Server Speaker: picks Chatterbox (cloned voice) or Kokoro per sentence. Workers and clock are injected so tests need no Python.
export const CHATTERBOX_BUDGET_MS = 4000;

export type SpeakerWorker = {
  ready: () => boolean;
  render: (text: string, clip?: string) => Promise<string>;
};

export type SpeakerPorts = {
  chatterbox: SpeakerWorker;
  kokoro: SpeakerWorker;
  readClip: () => string | undefined;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type SpeakResult = { audio: string; engine: "chatterbox" | "kokoro" | "loading" };

/** The pace of every spoken line: 1.1x, as the cloned voice has been played since PR #140. */
export const PLAYBACK_RATE = 1.1;

/** Where the speak script has kept the cloned voice's reference clip; used when the voice setting is empty. */
export const DEFAULT_REFERENCE_CLIP = join(homedir(), ".local", "share", "speak", "voice", "reference.wav");

/** The clip to clone from: the setting if set, else the existing default file, else none (Kokoro only). */
export function resolveReferenceClip(setting: string, exists: (path: string) => boolean = existsSync, fallback = DEFAULT_REFERENCE_CLIP): string | undefined {
  if (setting) return setting;
  return exists(fallback) ? fallback : undefined;
}

/** Plays a base64 WAV `rate` times faster by raising the sample rate in its header (a client can't change the rate itself, so it is baked in). Anything that is not a WAV is returned as it came. */
export function speedUp(base64: string, rate = PLAYBACK_RATE): string {
  const wav = Buffer.from(base64, "base64");
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 12, 16) !== "fmt ") return base64;
  wav.writeUInt32LE(Math.round(wav.readUInt32LE(24) * rate), 24);
  wav.writeUInt32LE(Math.round(wav.readUInt32LE(28) * rate), 28);
  return wav.toString("base64");
}

const TIMED_OUT = Symbol("timed out");
const REMEMBERED_REPLIES = 50;

export function createSpeaker(ports: SpeakerPorts) {
  const onKokoro = new Set<string>();
  const markKokoro = (replyId: string) => {
    onKokoro.add(replyId);
    if (onKokoro.size > REMEMBERED_REPLIES) onKokoro.delete(onKokoro.values().next().value as string);
  };
  const kokoroOrLoading = async (text: string): Promise<SpeakResult> =>
    ports.kokoro.ready() ? { audio: await ports.kokoro.render(text), engine: "kokoro" } : { audio: "", engine: "loading" };

  const render = async ({ text, replyId }: { text: string; replyId: string }): Promise<SpeakResult> => {
    const clip = ports.readClip();
    if (!clip || !ports.chatterbox.ready() || onKokoro.has(replyId)) return kokoroOrLoading(text);
    const started = ports.now();
    // Over budget: a slow but finished sentence keeps its Chatterbox audio; only a timeout or error re-renders on Kokoro. Either way the rest of the reply uses Kokoro.
    const budget = new AbortController();
    const outcome = await Promise.race([
      ports.chatterbox.render(text, clip).catch(() => TIMED_OUT),
      ports.sleep(CHATTERBOX_BUDGET_MS, budget.signal).then(() => TIMED_OUT),
    ]).finally(() => budget.abort());
    if (outcome === TIMED_OUT) {
      markKokoro(replyId);
      return kokoroOrLoading(text);
    }
    if (ports.now() - started > CHATTERBOX_BUDGET_MS) markKokoro(replyId);
    return { audio: outcome as string, engine: "chatterbox" };
  };
  return async (input: { text: string; replyId: string }): Promise<SpeakResult> => {
    const result = await render(input);
    return { ...result, audio: speedUp(result.audio) };
  };
}
