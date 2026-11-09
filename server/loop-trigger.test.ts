import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tickLoopStart } from "./loop-trigger";

const tmp = () => mkdtempSync(join(tmpdir(), "loop-trigger-"));

test("a loop start file files slices for the initiative and reports them, starting no loop", async () => {
  const dir = tmp();
  try {
    const file = join(dir, "initiative-loop-start.json");
    writeFileSync(file, JSON.stringify({ repo: "/work/repo", initiative: "login-fix" }));
    const filed: { repo: string; initiative: string }[] = [];
    await tickLoopStart(
      file,
      () => true,
      async (input) => {
        filed.push(input);
        return ["login-fix-s1", "login-fix-s2"];
      },
    );
    assert.deepEqual(filed, [{ repo: "/work/repo", initiative: "login-fix" }]);
    assert.equal(existsSync(file), false);
    const result = JSON.parse(readFileSync(join(dir, "initiative-loop-start.result.json"), "utf8"));
    assert.equal(result.ok, true);
    assert.deepEqual(result.slices, ["login-fix-s1", "login-fix-s2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed filing is written as an error result", async () => {
  const dir = tmp();
  try {
    const file = join(dir, "initiative-loop-start.json");
    writeFileSync(file, JSON.stringify({ repo: "/work/repo", initiative: "login-fix" }));
    await tickLoopStart(file, () => true, async () => {
      throw new Error("Pick a harness repo in settings first.");
    });
    const result = JSON.parse(readFileSync(join(dir, "initiative-loop-start.result.json"), "utf8"));
    assert.deepEqual({ ok: result.ok, error: result.error }, { ok: false, error: "Pick a harness repo in settings first." });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the start file waits while Paseo is not ready", async () => {
  const dir = tmp();
  try {
    const file = join(dir, "initiative-loop-start.json");
    writeFileSync(file, JSON.stringify({ repo: "/work/repo", initiative: "login-fix" }));
    const filed: unknown[] = [];
    await tickLoopStart(file, () => false, async (input) => (filed.push(input), []));
    assert.equal(existsSync(file), true);
    assert.deepEqual(filed, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
