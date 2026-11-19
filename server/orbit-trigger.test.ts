import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tickOrbit, type OrbitPorts } from "./orbit-trigger";

const tmp = () => mkdtempSync(join(tmpdir(), "orbit-trigger-"));

function recording() {
  const calls: unknown[] = [];
  const ports: OrbitPorts = {
    plan: async (input) => (calls.push(input), { ok: true, error: null, epic: ".harness/initiatives/debrief/phases/1-v1", agentId: "a1" }),
    start: async (input) => (calls.push(input), { ok: true, error: null, started: ["S1"], reason: "" }),
    stop: async (input) => (calls.push(input), { ok: true, error: null }),
  };
  return { calls, ports };
}

async function run(request: object, ports: OrbitPorts, ready = true) {
  const dir = tmp();
  const file = join(dir, "orbit.json");
  writeFileSync(file, JSON.stringify(request));
  try {
    await tickOrbit(file, () => ready, ports);
    const resultFile = join(dir, "orbit.result.json");
    return { left: existsSync(file), result: existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("plan starts a phase architect and reports its phase and session", async () => {
  const { calls, ports } = recording();
  const { left, result } = await run({ action: "plan", repo: "/work/repo", initiative: "debrief", phase: "Debrief v1" }, ports);
  assert.deepEqual(calls, [{ action: "plan", repo: "/work/repo", initiative: "debrief", phase: "Debrief v1", title: "" }]);
  assert.equal(left, false);
  assert.equal(result.ok, true);
  assert.equal(result.action, "plan");
  assert.equal(result.agentId, "a1");
});

test("start and stop reach the story loop with the repo and initiative", async () => {
  const { calls, ports } = recording();
  const started = await run({ action: "start", repo: "/work/repo", initiative: "debrief" }, ports);
  const stopped = await run({ action: "stop", repo: "/work/repo", initiative: "debrief" }, ports);
  assert.deepEqual(calls, [
    { action: "start", repo: "/work/repo", initiative: "debrief" },
    { action: "stop", repo: "/work/repo", initiative: "debrief" },
  ]);
  assert.deepEqual(started.result.started, ["S1"]);
  assert.equal(stopped.result.ok, true);
});

test("a loop that answers not ok is written as not ok", async () => {
  const { ports } = recording();
  ports.start = async () => ({ ok: false, error: "No initiative debrief in /work/repo.", started: [], reason: "" });
  const { result } = await run({ action: "start", repo: "/work/repo", initiative: "debrief" }, ports);
  assert.deepEqual({ ok: result.ok, error: result.error }, { ok: false, error: "No initiative debrief in /work/repo." });
});

test("an unknown action or a plan without a phase is an error result and starts nothing", async () => {
  const { calls, ports } = recording();
  const unknown = await run({ action: "launch", repo: "/work/repo", initiative: "debrief" }, ports);
  const noPhase = await run({ action: "plan", repo: "/work/repo", initiative: "debrief" }, ports);
  assert.deepEqual(calls, []);
  assert.equal(unknown.result.ok, false);
  assert.equal(noPhase.result.ok, false);
  assert.match(noPhase.result.error, /phase/);
});

test("the orbit file waits while Paseo is not ready", async () => {
  const { calls, ports } = recording();
  const { left, result } = await run({ action: "start", repo: "/work/repo", initiative: "debrief" }, ports, false);
  assert.equal(left, true);
  assert.equal(result, null);
  assert.deepEqual(calls, []);
});
