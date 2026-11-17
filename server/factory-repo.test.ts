import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { parseSliceState, type FactorySlice } from "../shared/factory";
import { configuredRepoFolders, expandHome, resolveSliceRepo, sliceRepoFolder } from "./factory-repo";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
const git = () => {
  const dir = tmp("repo-");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
};
const factory = (missionRepo: string) => {
  const root = tmp("factory-");
  const file = join(root, ".harness", "factory", "missions", "m1", "mission.md");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, missionRepo ? `---\nrepo: ${missionRepo}\n---\nOutcome.\n` : "Outcome.\n");
  return root;
};
const slice = (repo = ""): FactorySlice => ({ id: "s1", mission: "m1", state: parseSliceState({ repo }), spec: "", design: "", proof: "" });

test("a slice's repo wins over its mission's, which wins over the factory root", () => {
  const [a, b] = [git(), git()];
  const root = factory(a);
  assert.deepEqual(resolveSliceRepo(root, slice(b)), { ok: true, path: b, source: "slice" });
  assert.deepEqual(resolveSliceRepo(root, slice()), { ok: true, path: a, source: "mission" });
});

test("an unset repo is the factory root and is not checked for git", () => {
  const root = factory("");
  assert.deepEqual(resolveSliceRepo(root, slice()), { ok: true, path: root, source: "root" });
});

test("a repo that is not usable is an error naming where it was set", () => {
  const plain = tmp("plain-");
  const root = factory(plain);
  const bad = resolveSliceRepo(root, slice());
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.error, /mission m1's mission\.md is not a git repo/);
  const missing = resolveSliceRepo(root, slice(join(plain, "nope")));
  assert.match(missing.ok ? "" : missing.error, /slice s1's state\.md does not exist/);
  assert.match((resolveSliceRepo(root, slice("rel/path")) as { error: string }).error, /not an absolute or ~ path/);
});

test("~ expands to the home folder", () => {
  assert.notEqual(expandHome("~"), "~");
  assert.equal(expandHome("~/x"), join(expandHome("~"), "x"));
  assert.equal(expandHome("/abs"), "/abs");
});

test("sliceRepoFolder falls back to the factory root rather than failing", () => {
  const repo = git();
  const root = factory(repo);
  assert.equal(sliceRepoFolder(root, slice()), repo);
  assert.equal(sliceRepoFolder(root, slice(join(repo, "nope"))), root);
  assert.equal(sliceRepoFolder(factory(""), slice()), dirs[dirs.length - 1]);
});

test("configuredRepoFolders lists the factory root and every repo a slice names", () => {
  const [a, b] = [git(), git()];
  const root = factory(a);
  assert.deepEqual(new Set(configuredRepoFolders(root, [slice(), slice(b)])), new Set([resolve(root), a, b]));
});
