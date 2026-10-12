import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanTranscript, createTranscriber, MODEL_FILE, type TranscribePorts } from "./voice-transcribe";

const HOME = "/home/me";
const MODEL = `${HOME}/.orchestrator/voice/models/${MODEL_FILE}`;

function fake(over: { present?: string[]; stdout?: string; failOn?: string } = {}) {
  const present = new Set(over.present ?? ["/usr/bin/ffmpeg", "/opt/homebrew/bin/whisper-cli", MODEL]);
  const calls: { cmd: string; args: string[] }[] = [];
  const written: { path: string; bytes: Buffer }[] = [];
  const removed: string[] = [];
  const ports: TranscribePorts = {
    run: async (cmd, args) => {
      calls.push({ cmd, args });
      if (over.failOn && cmd.endsWith(over.failOn)) throw new Error("boom");
      return cmd.endsWith("whisper-cli") ? (over.stdout ?? " hello  world \n") : "";
    },
    exists: (path) => present.has(path),
    writeFile: async (path, bytes) => void written.push({ path, bytes }),
    remove: async (path) => void removed.push(path),
    tmpDir: "/tmp/x",
    home: HOME,
    pathDirs: ["/usr/bin"],
  };
  return { ports, calls, written, removed };
}

test("converts with ffmpeg, runs whisper with the model and hints, returns cleaned text", async () => {
  const f = fake();
  const out = await createTranscriber(f.ports)({ audio: Buffer.from("abc").toString("base64"), hints: ["merge", "Jarvis"] });
  assert.deepEqual(out, { text: "hello world" });
  assert.equal(f.written[0]!.bytes.toString(), "abc");
  const [ff, wh] = f.calls;
  assert.equal(ff!.cmd, "/usr/bin/ffmpeg");
  assert.ok(ff!.args.includes("16000") && ff!.args.includes("1") && ff!.args.includes(f.written[0]!.path));
  assert.equal(wh!.cmd, "/opt/homebrew/bin/whisper-cli");
  assert.deepEqual(wh!.args.slice(0, 2), ["-m", MODEL]);
  assert.equal(wh!.args[wh!.args.indexOf("--prompt") + 1], "merge, Jarvis");
  assert.ok(wh!.args.includes("-nt") && wh!.args.includes("-f"));
});

test("cleanTranscript drops bracketed noise markers and collapses whitespace", () => {
  assert.equal(cleanTranscript("[BLANK_AUDIO]\n"), "");
  assert.equal(cleanTranscript(" [MUSIC] merge   it\n (noise) now "), "merge it now");
});

test("removes every temp file, also when a step fails", async () => {
  const ok = fake();
  await createTranscriber(ok.ports)({ audio: "YQ==", hints: [] });
  assert.ok(ok.removed.length >= 2);
  const bad = fake({ failOn: "whisper-cli" });
  await assert.rejects(createTranscriber(bad.ports)({ audio: "YQ==", hints: [] }), /boom/);
  assert.ok(bad.removed.length >= 2);
});

test("a missing binary or model names what to install", async () => {
  await assert.rejects(
    createTranscriber(fake({ present: [MODEL, "/opt/homebrew/bin/whisper-cli"] }).ports)({ audio: "YQ==", hints: [] }),
    /ffmpeg.*brew install ffmpeg whisper-cpp/s,
  );
  await assert.rejects(
    createTranscriber(fake({ present: ["/usr/bin/ffmpeg", MODEL] }).ports)({ audio: "YQ==", hints: [] }),
    /whisper-cli.*brew install ffmpeg whisper-cpp/s,
  );
  const noModel = fake({ present: ["/usr/bin/ffmpeg", "/opt/homebrew/bin/whisper-cli"] });
  await assert.rejects(createTranscriber(noModel.ports)({ audio: "YQ==", hints: [] }), new RegExp(`ggml-small\\.en\\.bin.*${MODEL.replace(/\./g, "\\.")}`, "s"));
  assert.equal(noModel.calls.length, 0);
});
