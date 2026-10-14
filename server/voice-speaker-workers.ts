// Long-lived Python workers for the Speaker: Chatterbox Turbo (cloned voice) and Kokoro (am_michael). JSON lines over stdio, one sentence in, base64 WAV out.
// The spawn port is injected so tests need no Python or uv.
import { spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { SpeakerPorts, SpeakerWorker } from "./voice-speaker";

const MAX_RESTARTS = 5;

export type WorkerChild = {
  write: (line: string) => void;
  onLine: (cb: (line: string) => void) => void;
  // An error means the process could not start at all (for example uv is not installed).
  onExit: (cb: (error?: Error) => void) => void;
  kill: () => void;
};
export type SpawnPort = (cmd: string, args: string[]) => WorkerChild;

const CHATTERBOX_PY = `
import sys, json, base64, io
import soundfile as sf
import torch
from chatterbox.tts_turbo import ChatterboxTurboTTS
device = "mps" if torch.backends.mps.is_available() else "cpu"
model = ChatterboxTurboTTS.from_pretrained(device=device)
def out(m):
    sys.stdout.write(json.dumps(m) + "\\n"); sys.stdout.flush()
out({"ready": True})
for raw in sys.stdin:
    req = json.loads(raw)
    try:
        if req["op"] == "prepare":
            model.prepare_conditionals(req["clip"])
            out({"id": req["id"], "prepared": True})
        else:
            wav = model.generate(req["text"])
            buf = io.BytesIO()
            sf.write(buf, wav.squeeze().cpu().numpy(), model.sr, format="WAV")
            out({"id": req["id"], "audio": base64.b64encode(buf.getvalue()).decode()})
    except Exception as e:
        out({"id": req["id"], "error": str(e)})
`;

const KOKORO_PY = `
import sys, json, base64, io
import numpy as np
import soundfile as sf
from kokoro import KPipeline
pipe = KPipeline(lang_code="a")
def out(m):
    sys.stdout.write(json.dumps(m) + "\\n"); sys.stdout.flush()
out({"ready": True})
for raw in sys.stdin:
    req = json.loads(raw)
    try:
        parts = [np.asarray(a) for _, _, a in pipe(req["text"], voice="am_michael")]
        buf = io.BytesIO()
        sf.write(buf, np.concatenate(parts), 24000, format="WAV")
        out({"id": req["id"], "audio": base64.b64encode(buf.getvalue()).decode()})
    except Exception as e:
        out({"id": req["id"], "error": str(e)})
`;

const CHATTERBOX_ARGS = ["run", "--no-project", "--with", "chatterbox-tts", "--with", "setuptools<81", "--with", "soundfile", "python", "-u", "-c", CHATTERBOX_PY];
const KOKORO_ARGS = ["run", "--no-project", "--with", "kokoro>=0.9", "--with", "soundfile", "--with", "misaki[en]", "python", "-u", "-c", KOKORO_PY];

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void };

function createWorker(spawn: SpawnPort, args: string[], name: string, warn: (message: string) => void, prepares: boolean, readClip?: () => string | undefined) {
  let child: WorkerChild | undefined;
  let loaded = false;
  let stopped = false;
  let restarts = 0;
  let nextId = 1;
  let prepared: string | undefined;
  const pending = new Map<number, Pending>();

  const failAll = (error: Error) => {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };

  const launch = () => {
    loaded = false;
    prepared = undefined;
    let mine: WorkerChild;
    try {
      mine = spawn("uv", args);
    } catch (error) {
      warn(`The ${name} voice could not start: uv was not found or failed to run (${(error as Error).message}). Install uv from https://docs.astral.sh/uv/.`);
      return;
    }
    child = mine;
    mine.onLine((line) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.ready) {
        loaded = true;
        restarts = 0;
        // Warm at launch: prepare the cloned voice as soon as the model is up, so the first sentence is not slowed by it.
        const clip = prepares ? readClip?.() : undefined;
        if (clip) {
          // The worker handles requests in order, so a sentence sent right after this one waits for the voice to be ready.
          prepared = clip;
          call({ op: "prepare", clip }).catch(() => void (prepared = undefined));
        }
        return;
      }
      const waiter = pending.get(msg.id as number);
      if (!waiter) return;
      pending.delete(msg.id as number);
      if (msg.error) waiter.reject(new Error(String(msg.error)));
      else waiter.resolve(msg);
    });
    mine.onExit((error) => {
      if (child !== mine) return;
      loaded = false;
      child = undefined;
      failAll(new Error(`The ${name} worker exited.`));
      if (stopped) return;
      if (error) {
        warn(`The ${name} voice could not start: uv was not found or failed to run (${error.message}). Install uv from https://docs.astral.sh/uv/.`);
        return;
      }
      if (++restarts > MAX_RESTARTS) {
        warn(`The ${name} worker keeps exiting, so it will not be restarted again.`);
        return;
      }
      launch();
    });
  };

  const call = (message: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (!child || !loaded) return reject(new Error(`The ${name} worker is still loading.`));
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.write(JSON.stringify({ id, ...message }));
    });

  const worker: SpeakerWorker = {
    ready: () => loaded,
    render: async (text, clip) => {
      if (prepares && clip && clip !== prepared) {
        await call({ op: "prepare", clip });
        prepared = clip;
      }
      return String((await call({ op: "render", text })).audio);
    },
  };
  return {
    worker,
    start: () => {
      stopped = false;
      launch();
    },
    stop: () => {
      stopped = true;
      const current = child;
      child = undefined;
      loaded = false;
      failAll(new Error(`The ${name} worker was stopped.`));
      current?.kill();
    },
  };
}

export function createSpeakerWorkers(deps: { spawn: SpawnPort; warn: (message: string) => void; readClip?: () => string | undefined }) {
  const chatterbox = createWorker(deps.spawn, CHATTERBOX_ARGS, "Chatterbox", deps.warn, true, deps.readClip);
  const kokoro = createWorker(deps.spawn, KOKORO_ARGS, "Kokoro", deps.warn, false);
  return {
    chatterbox: chatterbox.worker,
    kokoro: kokoro.worker,
    start: () => {
      chatterbox.start();
      kokoro.start();
    },
    stop: () => {
      chatterbox.stop();
      kokoro.stop();
    },
  };
}

export const realSpawn: SpawnPort = (cmd, args) => {
  const proc = nodeSpawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: proc.stdout });
  proc.stdin.on("error", () => {});
  return {
    write: (line) => void proc.stdin.write(`${line}\n`),
    onLine: (cb) => void lines.on("line", cb),
    onExit: (cb) => {
      proc.on("error", (error) => cb(error));
      proc.on("exit", () => cb());
    },
    kill: () => void proc.kill(),
  };
};

// The sleep port takes an abort signal so the 4 s budget timer is cleared after each race instead of lingering.
export function realSpeakerPorts(readClip: () => string | undefined): SpeakerPorts & { start: () => void; stop: () => void } {
  const workers = createSpeakerWorkers({ spawn: realSpawn, warn: (message) => console.warn(`[orchestrator voice] ${message}`), readClip });
  return {
    chatterbox: workers.chatterbox,
    kokoro: workers.kokoro,
    readClip,
    now: Date.now,
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      }),
    start: workers.start,
    stop: workers.stop,
  };
}
