import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resultFile, takeStartRequest, tickReplayStart, writeStartResult } from "./replay-trigger";

const startFile = () => join(mkdtempSync(join(tmpdir(), "replay-trigger-")), "replay-start.json");
const readResult = (file: string) => JSON.parse(readFileSync(resultFile(file), "utf8"));

test("resultFile sits next to the start file", () => {
  assert.equal(resultFile("/x/replay-start.json"), "/x/replay-start.result.json");
});

test("takeStartRequest: no file is nothing to do", () => {
  const file = startFile();
  assert.equal(takeStartRequest(file), null);
  assert.equal(existsSync(resultFile(file)), false);
});

test("takeStartRequest: a valid file gives the input and is removed", () => {
  const file = startFile();
  writeFileSync(file, JSON.stringify({ root: "/repo", costCap: 5, controls: 2 }));
  assert.deepEqual(takeStartRequest(file), { ok: true, input: { root: "/repo", costCap: 5, controls: 2 } });
  assert.equal(existsSync(file), false);
});

test("takeStartRequest: bad JSON or a schema failure is an error, written out, and the file is removed", () => {
  for (const body of ["{not json", JSON.stringify({ costCap: 5 }), JSON.stringify({ root: "/repo", costCap: -1 })]) {
    const file = startFile();
    writeFileSync(file, body);
    const taken = takeStartRequest(file);
    assert.equal(taken?.ok, false, body);
    assert.equal(existsSync(file), false, body);
    const result = readResult(file);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, "string");
    assert.equal(typeof result.at, "string");
  }
});

test("writeStartResult overwrites the result file", () => {
  const file = startFile();
  writeStartResult(file, { ok: false, error: "first" });
  writeStartResult(file, { ok: true, run: "run", rounds: 3, costCap: 20, runDir: "/repo/.harness/replay/run" });
  const result = readResult(file);
  assert.deepEqual({ ...result, at: undefined }, { at: undefined, ok: true, run: "run", rounds: 3, costCap: 20, runDir: "/repo/.harness/replay/run" });
});

test("tickReplayStart: leaves the file while there is no Paseo API, then starts once and writes the outcome", async () => {
  const file = startFile();
  writeFileSync(file, JSON.stringify({ root: "/repo" }));
  const started: unknown[] = [];
  const start = async (input: unknown) => (started.push(input), { run: "run", rounds: 1, costCap: 20, runDir: "/d" });
  await tickReplayStart(file, () => false, start);
  assert.equal(existsSync(file), true);
  assert.deepEqual(started, []);
  await tickReplayStart(file, () => true, start);
  await tickReplayStart(file, () => true, start);
  assert.deepEqual(started, [{ root: "/repo" }]);
  assert.equal(readResult(file).ok, true);
  assert.equal(readResult(file).run, "run");
});

test("tickReplayStart: a refused start is written as an error", async () => {
  const file = startFile();
  writeFileSync(file, JSON.stringify({ root: "/repo" }));
  await tickReplayStart(file, () => true, async () => {
    throw new Error("A memory replay is already running.");
  });
  assert.deepEqual({ ...readResult(file), at: undefined }, { at: undefined, ok: false, error: "A memory replay is already running." });
});
