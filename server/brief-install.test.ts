import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { briefScript } from "../shared/brief";

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
