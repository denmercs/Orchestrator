import assert from "node:assert/strict";
import { test } from "node:test";
import { createWakeModelLoader, WAKE_MODEL_FILES, type WakeModelPorts } from "./voice-wake-models";

const HOME = "/home/me";
const CACHE_DIR = `${HOME}/.orchestrator/voice/models/wake`;

function fake(over: { present?: string[]; failOn?: string } = {}) {
  const present = new Set(over.present ?? []);
  const fetched: string[] = [];
  const written: { path: string; bytes: Buffer }[] = [];
  const renamed: { from: string; to: string }[] = [];
  const removed: string[] = [];
  const ports: WakeModelPorts = {
    fetchModel: async (url) => {
      fetched.push(url);
      if (over.failOn && url.includes(over.failOn)) throw new Error("boom");
      return Buffer.from(`bytes-for-${url}`);
    },
    exists: (path) => present.has(path),
    readFile: async (path) => Buffer.from(`cached-${path}`),
    mkdir: async () => undefined,
    writeFile: async (path, bytes) => void written.push({ path, bytes }),
    rename: async (from, to) => void renamed.push({ from, to }),
    remove: async (path) => void removed.push(path),
    home: HOME,
  };
  return { ports, fetched, written, renamed, removed };
}

test("first call downloads the release file into the cache dir and returns it as base64", async () => {
  const f = fake();
  const out = await createWakeModelLoader(f.ports)("hey_jarvis");
  assert.equal(f.fetched.length, 1);
  assert.ok(f.fetched[0]!.includes(WAKE_MODEL_FILES.hey_jarvis));
  const expectedFile = `${CACHE_DIR}/${WAKE_MODEL_FILES.hey_jarvis}`;
  assert.equal(f.written[0]!.path, `${expectedFile}.incomplete`);
  assert.deepEqual(f.renamed[0], { from: `${expectedFile}.incomplete`, to: expectedFile });
  assert.equal(out.bytes, Buffer.from(`bytes-for-${f.fetched[0]}`).toString("base64"));
});

test("second call reads the cached file and does not fetch again", async () => {
  const expectedFile = `${CACHE_DIR}/${WAKE_MODEL_FILES.melspectrogram}`;
  const f = fake({ present: [expectedFile] });
  const out = await createWakeModelLoader(f.ports)("melspectrogram");
  assert.equal(f.fetched.length, 0);
  assert.equal(out.bytes, Buffer.from(`cached-${expectedFile}`).toString("base64"));
});

test("a failed download leaves no partial file", async () => {
  const f = fake({ failOn: WAKE_MODEL_FILES.embedding });
  await assert.rejects(createWakeModelLoader(f.ports)("embedding"));
  assert.equal(f.written.length, 0);
  assert.equal(f.renamed.length, 0);
  const expectedFile = `${CACHE_DIR}/${WAKE_MODEL_FILES.embedding}`;
  assert.deepEqual(f.removed, [`${expectedFile}.incomplete`]);
});
