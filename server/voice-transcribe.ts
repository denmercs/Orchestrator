// Speech to text on this machine: base64 webm/opus -> ffmpeg 16 kHz mono wav -> whisper.cpp. Ports are injected so tests need no binaries.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export const MODEL_FILE = "ggml-small.en.bin";
const FALLBACK_DIR = "/opt/homebrew/bin";
const INSTALL = "Install them with `brew install ffmpeg whisper-cpp`.";

export type TranscribePorts = {
  run: (cmd: string, args: string[]) => Promise<string>;
  exists: (path: string) => boolean;
  writeFile: (path: string, bytes: Buffer) => Promise<void>;
  remove: (path: string) => Promise<void>;
  tmpDir: string;
  home: string;
  pathDirs: string[];
};

export const realTranscribePorts = (): TranscribePorts => ({
  run: (cmd, args) =>
    new Promise((resolve, reject) =>
      execFile(cmd, args, { timeout: 120_000, maxBuffer: 10_000_000 }, (error, stdout, stderr) =>
        error ? reject(new Error(`${cmd} failed: ${(stderr || error.message).slice(0, 300)}`)) : resolve(stdout),
      ),
    ),
  exists: existsSync,
  writeFile: (path, bytes) => writeFile(path, bytes),
  remove: (path) => rm(path, { force: true }),
  tmpDir: tmpdir(),
  home: homedir(),
  pathDirs: (process.env.PATH ?? "").split(delimiter).filter(Boolean),
});

// Drops bracketed markers such as [BLANK_AUDIO] or (noise), then collapses whitespace.
export const cleanTranscript = (raw: string) =>
  raw
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function createTranscriber(ports: TranscribePorts) {
  const find = (name: string) => [...ports.pathDirs, FALLBACK_DIR].map((dir) => join(dir, name)).find((path) => ports.exists(path));
  return async (input: { audio: string; hints: string[] }): Promise<{ text: string }> => {
    const ffmpeg = find("ffmpeg");
    if (!ffmpeg) throw new Error(`ffmpeg was not found on PATH or in ${FALLBACK_DIR}. ${INSTALL}`);
    const whisper = find("whisper-cli");
    if (!whisper) throw new Error(`whisper-cli was not found on PATH or in ${FALLBACK_DIR}. ${INSTALL}`);
    const model = join(ports.home, ".orchestrator", "voice", "models", MODEL_FILE);
    if (!ports.exists(model)) throw new Error(`The whisper model is missing. Download ${MODEL_FILE} to ${model}.`);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const source = join(ports.tmpDir, `voice-${stamp}.webm`);
    const wav = join(ports.tmpDir, `voice-${stamp}.wav`);
    try {
      await ports.writeFile(source, Buffer.from(input.audio, "base64"));
      await ports.run(ffmpeg, ["-y", "-i", source, "-ar", "16000", "-ac", "1", wav]);
      const args = ["-m", model, "-f", wav, "-nt"];
      if (input.hints.length) args.push("--prompt", input.hints.join(", "));
      return { text: cleanTranscript(await ports.run(whisper, args)) };
    } finally {
      await Promise.all([ports.remove(source), ports.remove(wav)]);
    }
  };
}
