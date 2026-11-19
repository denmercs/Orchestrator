import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createInitiative, describe, mainCheckout, parseArgs, request, status } from "./orbit.mjs";

const SCRIPT = fileURLToPath(new URL("./orbit.mjs", import.meta.url));
const tmp = (name) => mkdtempSync(join(tmpdir(), `orbit-${name}-`));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function story(repo, slug, phase, file, meta) {
  const dir = join(repo, ".harness", "initiatives", slug, "phases", phase, "stories");
  mkdirSync(dir, { recursive: true });
  const lines = Object.entries(meta).map(([k, v]) => `${k}: ${v}`);
  writeFileSync(join(dir, file), `---\n${lines.join("\n")}\n---\n\n# ${meta.title}\n`);
}

// Stands in for the plugin: takes the request file and answers it, like server/start-file.ts.
async function fakePlugin(home, answer) {
  const file = join(home, "orbit.json");
  while (!existsSync(file)) await sleep(20);
  const body = JSON.parse(readFileSync(file, "utf8"));
  rmSync(file);
  writeFileSync(join(home, "orbit.result.json"), JSON.stringify({ at: "now", ...answer(body) }));
  return body;
}

test("flags take a value and the rest are positional", () => {
  assert.deepEqual(parseArgs(["plan", "debrief", "Debrief v1", "--title", "Debrief"]), {
    command: "plan",
    args: ["debrief", "Debrief v1"],
    flags: { title: "Debrief" },
  });
  assert.throws(() => parseArgs(["start", "debrief", "--repo"]), /--repo needs a value/);
});

test("new writes a local initiative with its outcome and refuses to overwrite it", () => {
  const repo = tmp("repo");
  try {
    const file = createInitiative(repo, "debrief", "Every story stops at a Debrief page.", "Debrief");
    const text = readFileSync(file, "utf8");
    assert.match(text, /^---\ntracker: local\n---/);
    assert.match(text, /# Initiative: Debrief/);
    assert.match(text, /## Outcome\n\nEvery story stops at a Debrief page\./);
    assert.throws(() => createInitiative(repo, "debrief", "again"), /already exists/);
    assert.throws(() => createInitiative(repo, "Bad Slug", "x"), /lowercase/);
    assert.throws(() => createInitiative(repo, "other", " "), /Say what is true/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("status lists stories and what waits on you", () => {
  const repo = tmp("repo");
  try {
    createInitiative(repo, "debrief", "Done when it ships.");
    story(repo, "debrief", "1-v1", "01-a.md", { id: "S1", title: "Notes format", status: "merged" });
    story(repo, "debrief", "1-v1", "02-b.md", { id: "S2", title: "Render script", status: "awaiting-approval" });
    story(repo, "debrief", "1-v1", "03-c.md", { id: "S3", title: "Coverage", status: "pr-open", pr: 12, ci: "green" });
    story(repo, "debrief", "1-v1", "04-d.md", { id: "S4", title: "Loop step", status: "blocked", blocked_reason: "CI red 3 times" });
    const out = status(repo);
    assert.match(out, /debrief \(loop off\)/);
    assert.match(out, /1-v1: 1\/4 merged/);
    assert.match(out, /S2 +awaiting-approval +Render script/);
    assert.match(out, /Waiting on you:\n {2}debrief S2: approve the plan\n {2}debrief S3: merge PR #12 \(CI green\)\n {2}debrief S4: blocked: CI red 3 times/);
    assert.throws(() => status(repo, "missing"), /No initiative missing/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("status with no initiatives says how to create one", () => {
  const repo = tmp("repo");
  try {
    assert.match(status(repo), /No initiatives in .*orbit new/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a request is answered by the plugin and its result is consumed", async () => {
  const home = tmp("home");
  try {
    const [result, body] = await Promise.all([
      request({ action: "start", repo: "/work/repo", initiative: "debrief" }, { home, pollMs: 20 }),
      fakePlugin(home, () => ({ ok: true, error: null, started: ["S1"], reason: "" })),
    ]);
    assert.deepEqual(body, { action: "start", repo: "/work/repo", initiative: "debrief" });
    assert.deepEqual(result.started, ["S1"]);
    assert.equal(existsSync(join(home, "orbit.result.json")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a request nobody answers is removed so it can't run later", async () => {
  const home = tmp("home");
  try {
    await assert.rejects(request({ action: "stop", repo: "/r", initiative: "x" }, { home, waitMs: 100, pollMs: 20 }), /didn't answer/);
    assert.equal(existsSync(join(home, "orbit.json")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a request already waiting is not overwritten", async () => {
  const home = tmp("home");
  try {
    writeFileSync(join(home, "orbit.json"), "{}");
    await assert.rejects(request({ action: "stop", repo: "/r", initiative: "x" }, { home, waitMs: 100 }), /still waiting/);
    assert.equal(readFileSync(join(home, "orbit.json"), "utf8"), "{}");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("results read as plain sentences", () => {
  assert.equal(
    describe("start", {
      ok: true,
      started: [
        { story: "S1", agentId: "a1" },
        { story: "S2", agentId: "a2" },
      ],
    }),
    "Loop on. Started: S1, S2.",
  );
  assert.equal(describe("start", { ok: true, started: ["S1", "S2"] }), "Loop on. Started: S1, S2.");
  assert.equal(describe("start", { ok: true, started: [], reason: "the initiative has no phases yet" }), "Loop on. Nothing started: the initiative has no phases yet");
  assert.match(describe("plan", { ok: true, epic: "phases/1-v1", agentId: "a1", warning: null }), /Architecture session started \(a1\)/);
  assert.equal(describe("stop", { ok: false, error: "No initiative x." }), "stop failed: No initiative x.");
});

test("a worktree resolves to its main checkout", () => {
  const repo = tmp("git");
  const tree = join(tmp("tree"), "wt");
  try {
    const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    git("worktree", "add", "-q", tree);
    assert.equal(mainCheckout(tree), mainCheckout(repo));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(tree, { recursive: true, force: true });
  }
});

test("the command plans a phase through the plugin, end to end", async () => {
  const home = tmp("home");
  const repo = tmp("repo");
  try {
    const child = spawn(process.execPath, [SCRIPT, "plan", "debrief", "Debrief v1", "--repo", repo, "--wait", "5"], {
      env: { ...process.env, HOME: home },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    const body = await fakePlugin(join(home, ".orchestrator"), () => ({ ok: true, error: null, epic: "phases/1-debrief-v1", agentId: "a9", warning: null }));
    const code = await new Promise((done) => child.on("close", done));
    assert.equal(code, 0);
    assert.deepEqual(body, { action: "plan", repo, initiative: "debrief", phase: "Debrief v1", title: "" });
    assert.match(stdout, /Phase created: phases\/1-debrief-v1/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
