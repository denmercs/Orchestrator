import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { briefScript } from "../shared/brief";
import { briefTag, installBrief } from "./brief-install";

test("briefScript runs standalone: exit code, header, full log, pruned to 20", () => {
  const dir = mkdtempSync(join(tmpdir(), "brief-"));
  try {
    const bin = join(dir, ".harness", "bin");
    const logs = join(dir, ".harness", "logs");
    mkdirSync(bin, { recursive: true });
    mkdirSync(logs, { recursive: true });
    const script = join(bin, "brief");
    writeFileSync(script, briefScript("implement-c1"));
    chmodSync(script, 0o755);
    for (let i = 0; i < 22; i++) {
      const old = join(logs, `plan-old-${String(i).padStart(2, "0")}.log`);
      writeFileSync(old, "old\n");
      utimesSync(old, 1_000_000 + i, 1_000_000 + i);
    }

    const run = spawnSync(script, [process.execPath, "-e", "console.log('x'); process.exit(3)"], {
      cwd: dir,
      encoding: "utf8",
    });

    assert.equal(run.status, 3, run.stderr);
    assert.match(run.stdout, /^brief: exit 3 · 1 lines · full log \.harness\/logs\/implement-c1-[^ ]+\.log$/m);
    assert.match(run.stdout, /^x$/m);
    const left = readdirSync(logs);
    assert.equal(left.length, 20);
    const mine = left.filter((name) => /^implement-c1-.+\.log$/.test(name));
    assert.equal(mine.length, 1);
    assert.equal(readFileSync(join(logs, mine[0]), "utf8"), "x\n");
    assert.ok(!left.includes("plan-old-00.log"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A brief script for `step` in a fresh temp dir, with its logs dir.
function briefDir(step: string) {
  const dir = mkdtempSync(join(tmpdir(), "brief-"));
  const bin = join(dir, ".harness", "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "brief");
  writeFileSync(script, briefScript(step));
  chmodSync(script, 0o755);
  return { dir, script, logs: join(dir, ".harness", "logs") };
}

test("briefScript marks its run with <step>-<pid>.running while it goes, and removes it after", () => {
  const { dir, script, logs } = briefDir("implement-c1");
  try {
    const list = "console.log(require('fs').readFileSync(require('path').join('.harness','logs',require('fs').readdirSync('.harness/logs').find((n)=>n.endsWith('.running'))),'utf8'))";
    const run = spawnSync(script, [process.execPath, "-e", list], { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const marker = JSON.parse(/^\{.*\}$/m.exec(run.stdout)?.[0] ?? "{}") as { pid?: number; startedAt?: string };
    assert.equal(typeof marker.pid, "number");
    assert.ok(Date.parse(marker.startedAt ?? ""));
    const log = readdirSync(logs).find((name) => name.endsWith(".log")) ?? "";
    assert.ok(readFileSync(join(logs, log), "utf8").includes(`"pid":${marker.pid}`));
    assert.deepEqual(readdirSync(logs).filter((name) => name.endsWith(".running")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("briefScript removes its marker when it is killed with SIGTERM", async () => {
  const { dir, script, logs } = briefDir("implement");
  try {
    const child = spawn(script, [process.execPath, "-e", "setTimeout(() => {}, 30000)"], { cwd: dir, stdio: "ignore" });
    const marker = join(logs, `implement-${child.pid}.running`);
    for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(existsSync(marker));
    const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    child.kill("SIGTERM");
    assert.equal(await exit, 143);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installBrief writes an executable brief kept out of git", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brief-install-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    await installBrief(dir, "plan");

    const script = join(dir, ".harness", "bin", "brief");
    accessSync(script, constants.X_OK);
    assert.equal(readFileSync(script, "utf8"), briefScript("plan"));
    const ignored = spawnSync("git", ["check-ignore", ".harness/bin/brief", ".harness/logs/x.log"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(ignored.status, 0, ignored.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("briefTag names the step, its cycle and its round", () => {
  assert.equal(briefTag("implement", 2, 2), "implement-c2-r2");
  assert.equal(briefTag("plan", 1), "plan");
  assert.equal(briefTag("fix", 3), "fix-r3");
});

// Writes `briefScript` into a temp `.harness/bin/brief` and runs it with `args`.
function runBrief(args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "brief-run-"));
  try {
    const bin = join(dir, ".harness", "bin");
    mkdirSync(bin, { recursive: true });
    const script = join(bin, "brief");
    writeFileSync(script, briefScript("implement-c1"));
    chmodSync(script, 0o755);
    const run = spawnSync(script, args, { cwd: dir, encoding: "utf8", timeout: 5000 });
    const logs = join(dir, ".harness", "logs");
    const log = run.status === null ? "" : readFileSync(join(logs, readdirSync(logs)[0]), "utf8");
    return { run, log };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("briefScript does not leave the command waiting on stdin", () => {
  const { run } = runBrief([process.execPath, "-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"]);
  assert.equal(run.status, 0, `timed out or failed: ${run.error ?? run.stderr}`);
});

test("briefScript keeps a multibyte character split across output chunks", () => {
  const split = "process.stdout.write(Buffer.from([0xe2])); setTimeout(() => process.stdout.write(Buffer.from([0x9c, 0x96, 0x0a])), 100)";
  const { run, log } = runBrief([process.execPath, "-e", split]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(log, "✖\n");
  assert.match(run.stdout, /^✖$/m);
});
