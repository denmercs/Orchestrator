import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { INCLUDE, parseArgs, sync } from "./harness-sync.mjs";

// Two "devices" share one bare repo that stands in for the private remote.
function setup() {
  const root = mkdtempSync(join(tmpdir(), "harness-sync-"));
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  const device = (name) => {
    const harness = join(root, name, ".harness");
    mkdirSync(harness, { recursive: true });
    const run = (mode, extra = {}) =>
      sync({ mode, remote, project: "Orch", harness, cloneDir: join(root, name, "clone"), ...extra }, { log: () => {}, isPrivate: () => true, device: name });
    return { harness, run };
  };
  return { remote, a: device("a"), b: device("b") };
}

const write = (harness, rel, text) => {
  mkdirSync(join(harness, rel, ".."), { recursive: true });
  writeFileSync(join(harness, rel), text);
};

test("parseArgs needs a mode and rejects unknown flags", () => {
  assert.equal(parseArgs(["push", "--force"]).force, true);
  assert.throws(() => parseArgs([]), /push or pull/);
  assert.throws(() => parseArgs(["push", "--nope"]), /unknown argument/);
  assert.throws(() => parseArgs(["push", "--remote"]), /needs a value/);
});

test("push then pull on another device carries initiatives, factory and memory but not replay", () => {
  const { a, b } = setup();
  write(a.harness, "initiatives/x/initiative.md", "plan");
  write(a.harness, "factory/digest.md", "digest");
  write(a.harness, "memory/m.md", "mem");
  write(a.harness, "replay/big.json", "23MB");
  a.run("push");
  b.run("pull");
  assert.equal(readFileSync(join(b.harness, "initiatives/x/initiative.md"), "utf8"), "plan");
  assert.equal(readFileSync(join(b.harness, "factory/digest.md"), "utf8"), "digest");
  assert.equal(existsSync(join(b.harness, "replay")), false);
  assert.deepEqual(INCLUDE, ["initiatives", "factory", "memory"]);
});

test("a file deleted on one device is deleted on the other after a round trip", () => {
  const { a, b } = setup();
  write(a.harness, "initiatives/x/old.md", "old");
  write(a.harness, "initiatives/x/keep.md", "keep");
  a.run("push");
  b.run("pull");
  rmSync(join(a.harness, "initiatives/x/old.md"));
  a.run("push");
  b.run("pull");
  assert.equal(existsSync(join(b.harness, "initiatives/x/old.md")), false);
  assert.equal(existsSync(join(b.harness, "initiatives/x/keep.md")), true);
});

test("push refuses when the remote has newer state, and --force overrides", () => {
  const { a, b } = setup();
  write(a.harness, "factory/digest.md", "one");
  a.run("push");
  b.run("pull");
  write(a.harness, "factory/digest.md", "two");
  a.run("push");
  write(b.harness, "factory/digest.md", "three");
  assert.throws(() => b.run("push"), /newer state from a/);
  b.run("push", { force: true });
  a.run("pull", { force: true });
  assert.equal(readFileSync(join(a.harness, "factory/digest.md"), "utf8"), "three");
});

test("pull refuses to overwrite local changes that were never pushed", () => {
  const { a, b } = setup();
  write(a.harness, "factory/digest.md", "one");
  a.run("push");
  b.run("pull");
  write(b.harness, "factory/digest.md", "local edit");
  assert.throws(() => b.run("pull"), /never pushed/);
  b.run("pull", { force: true });
  assert.equal(readFileSync(join(b.harness, "factory/digest.md"), "utf8"), "one");
});

test("pull says so when nothing is stored", () => {
  assert.throws(() => setup().a.run("pull"), /nothing stored/);
});

test("push to a remote that is not private is refused", () => {
  const { remote, a } = setup();
  write(a.harness, "factory/digest.md", "x");
  assert.throws(
    () => sync({ mode: "push", remote, project: "Orch", harness: a.harness, cloneDir: join(a.harness, "..", "c") }, { isPrivate: () => false }),
    /not private/,
  );
});

// .harness holds plans and notes that must not go public, so no file under it may ever be tracked here.
test("no .harness file is tracked in this repo", () => {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const tracked = execFileSync("git", ["ls-files", ".harness"], { cwd: repo, encoding: "utf8" }).trim();
  assert.equal(tracked, "");
});
