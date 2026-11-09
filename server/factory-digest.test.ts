import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { renderDigest, writeDigest } from "./factory-digest";
import { factoryDir, readFactory, sliceDir } from "./factory-layout";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const put = (file: string, text: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};

// A factory with a project and one mission; `slices` maps a slice id to its state.md frontmatter body.
function setup(slices: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "digest-"));
  roots.push(root);
  put(join(factoryDir(root), "project.md"), "Ship the widget shop.\n");
  put(join(factoryDir(root), "missions", "m1", "mission.md"), "Outcome: checkout works.\n");
  for (const [id, state] of Object.entries(slices)) put(join(sliceDir(root, "m1", id), "state.md"), `---\n${state}\n---\n`);
  return root;
}

const digestOf = (root: string) => renderDigest(readFactory(root));

test("the digest names the project and lists a runnable slice under Running", () => {
  const text = digestOf(setup({ s1: "phase: build\nrun: on" }));
  assert.match(text, /^Project: Ship the widget shop\./);
  assert.match(text, /## Running\n- m1\/s1: phase build\n/);
  assert.match(text, /## Blocked\n\(none\)/);
  assert.match(text, /## Needs you\n\(none\)/);
});

test("a clean review, a ship slice with an unmerged PR and a steered plan each need you", () => {
  const text = digestOf(
    setup({
      a: "phase: review\nrun: on\nready: review",
      b: "phase: ship\nkind: ship\nrun: on\nready: ci\npr: https://x/pr/7",
      c: "phase: spec\nrun: on\nsteered: plan",
    }),
  );
  const needs = text.split("## Needs you\n")[1];
  assert.match(needs, /m1\/a: phase review, review is clean/);
  assert.match(needs, /m1\/b: phase ship, PR https:\/\/x\/pr\/7 waits on your merge/);
  assert.match(needs, /m1\/c: phase spec, plan awaits your approval/);
  assert.doesNotMatch(text.split("## Needs you")[0], /m1\/a|m1\/b/);
});

test("a merged ship slice no longer waits on you", () => {
  const text = digestOf(setup({ b: "phase: ship\nkind: ship\nrun: on\nready: ci\npr: https://x/pr/7\nmerged: 2026-01-01T00:00:00Z" }));
  assert.match(text, /## Needs you\n\(none\)/);
});

test("a blocked slice and a slice held by it sit under Blocked, not Running", () => {
  const text = digestOf(setup({ a: "phase: build\nrun: on\nready: blocked", b: "phase: spec\nrun: on\ndepends: a" }));
  const [running, rest] = text.split("## Blocked\n");
  assert.match(rest, /m1\/a: phase build, blocked\n/);
  assert.match(rest, /m1\/b: phase spec, blocked dependency a\n/);
  assert.match(running, /## Running\n\(none\)/);
});

test("an empty factory with only a project shows (none) in every section", () => {
  const root = mkdtempSync(join(tmpdir(), "digest-"));
  roots.push(root);
  put(join(factoryDir(root), "project.md"), "Just intent.\n");
  assert.equal(digestOf(root), "Project: Just intent.\n\n## Running\n(none)\n\n## Blocked\n(none)\n\n## Needs you\n(none)\n");
});

test("writeDigest writes digest.md in the factory dir", () => {
  const root = setup({ s1: "phase: build\nrun: on" });
  writeDigest(root);
  assert.equal(readFileSync(join(factoryDir(root), "digest.md"), "utf8"), digestOf(root));
});

test("a repo with no factory gets no file and no directory", () => {
  const root = mkdtempSync(join(tmpdir(), "digest-"));
  roots.push(root);
  writeDigest(root);
  assert.equal(existsSync(join(root, ".harness")), false);
});

test("unchanged content is not rewritten, changed content is", () => {
  const root = setup({ s1: "phase: build\nrun: on" });
  writeDigest(root);
  const file = join(factoryDir(root), "digest.md");
  const old = new Date("2020-01-01T00:00:00Z");
  utimesSync(file, old, old);
  writeDigest(root);
  assert.equal(statSync(file).mtimeMs, old.getTime());
  put(join(sliceDir(root, "m1", "s1"), "state.md"), "---\nphase: review\nrun: on\nready: review\n---\n");
  writeDigest(root);
  assert.match(readFileSync(file, "utf8"), /review is clean/);
});
