// Downloads the three openWakeWord ONNX models once into a local cache, then serves them from disk. The client
// cannot fetch GitHub release assets directly (S0 lesson 4), so this sits behind orchestration.voice.wake-model.
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const RELEASE = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1";

export const WAKE_MODEL_FILES = {
  melspectrogram: "melspectrogram.onnx",
  embedding: "embedding_model.onnx",
  hey_jarvis: "hey_jarvis_v0.1.onnx",
} as const;

export type WakeModelName = keyof typeof WAKE_MODEL_FILES;

export type WakeModelPorts = {
  fetchModel: (url: string) => Promise<Buffer>;
  exists: (path: string) => boolean;
  readFile: (path: string) => Promise<Buffer>;
  mkdir: (path: string) => Promise<void>;
  writeFile: (path: string, bytes: Buffer) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  home: string;
};

export const realWakeModelPorts = (): WakeModelPorts => ({
  fetchModel: async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Downloading ${url} failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  },
  exists: existsSync,
  readFile: (path) => readFile(path),
  mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
  writeFile: (path, bytes) => writeFile(path, bytes),
  rename: (from, to) => rename(from, to),
  remove: (path) => rm(path, { force: true }),
  home: homedir(),
});

export function createWakeModelLoader(ports: WakeModelPorts) {
  return async (model: WakeModelName): Promise<{ bytes: string }> => {
    const file = WAKE_MODEL_FILES[model];
    const dir = join(ports.home, ".orchestrator", "voice", "models", "wake");
    const dest = join(dir, file);
    if (ports.exists(dest)) return { bytes: (await ports.readFile(dest)).toString("base64") };
    const partial = `${dest}.incomplete`;
    await ports.mkdir(dir);
    let bytes: Buffer;
    try {
      bytes = await ports.fetchModel(`${RELEASE}/${file}`);
    } catch (error) {
      await ports.remove(partial);
      throw error;
    }
    await ports.writeFile(partial, bytes);
    await ports.rename(partial, dest);
    return { bytes: bytes.toString("base64") };
  };
}
