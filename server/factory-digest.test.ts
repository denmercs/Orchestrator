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
  // Arrange + Act: one runnable slice, rendered
  const text = digestOf(setup({ s1: "phase: build\nrun: on" }));
  // Assert: the intent leads, the slice runs, the other sections are empty
  assert.match(text, /^Project: Ship the widget shop\./);
  assert.match(text, /## Running\n- m1\/s1: phase build\n/);
  assert.match(text, /## Blocked\n\(none\)/);
  assert.match(text, /## Needs you\n\(none\)/);
});

test("a clean review, a ship slice with an unmerged PR and a steered plan each need you", () => {
  // Arrange + Act: the three ways a slice waits on the human
  const text = digestOf(
    setup({
      a: "phase: review\nrun: on\nready: review",
      b: "phase: ship\nkind: ship\nrun: on\nready: ci\npr: https://x/pr/7",
      c: "phase: spec\nrun: on\nsteered: plan",
    }),
  );
  // Assert: each is under Needs you with its reason, and none is also under Running
  const needs = text.split("## Needs you\n")[1];
  assert.match(needs, /m1\/a: phase review, review is clean/);
  assert.match(needs, /m1\/b: phase ship, PR https:\/\/x\/pr\/7 waits on your merge/);
  assert.match(needs, /m1\/c: phase spec, plan awaits your approval/);
  assert.doesNotMatch(text.split("## Needs you")[0], /m1\/a|m1\/b|m1\/c/);
});

test("a closed or archived slice appears in no section, even at ready review or blocked", () => {
  // Arrange: a scout slice the manager closed, an archived blocked one, and a live slice for contrast
  const text = digestOf(
    setup({
      done: "phase: review\nrun: on\nclose: on\nready: review",
      old: "phase: build\nrun: on\nready: blocked\narchived: on",
      live: "phase: build\nrun: on",
    }),
  );
  // Assert: only the live slice is listed
  assert.doesNotMatch(text, /m1\/done|m1\/old/);
  assert.match(text, /## Running\n- m1\/live: phase build\n/);
});

test("a merged ship slice no longer waits on you", () => {
  // Arrange + Act: a ship slice whose PR is already merged
  const text = digestOf(setup({ b: "phase: ship\nkind: ship\nrun: on\nready: ci\npr: https://x/pr/7\nmerged: 2026-01-01T00:00:00Z" }));
  // Assert: nothing is left for the human to do
  assert.match(text, /## Needs you\n\(none\)/);
});

test("a blocked slice and a slice held by it sit under Blocked, not Running", () => {
  // Arrange + Act: a blocked slice and a slice that depends on it
  const text = digestOf(setup({ a: "phase: build\nrun: on\nready: blocked", b: "phase: spec\nrun: on\ndepends: a" }));
  // Assert: both are under Blocked with their cause and Running is empty
  const [running, rest] = text.split("## Blocked\n");
  assert.match(rest, /m1\/a: phase build, blocked\n/);
  assert.match(rest, /m1\/b: phase spec, blocked dependency a\n/);
  assert.match(running, /## Running\n\(none\)/);
});

test("an empty factory with only a project shows (none) in every section", () => {
  // Arrange: a project and no missions
  const root = mkdtempSync(join(tmpdir(), "digest-"));
  roots.push(root);
  put(join(factoryDir(root), "project.md"), "Just intent.\n");
  // Act + Assert: every section reads (none)
  assert.equal(digestOf(root), "Project: Just intent.\n\n## Running\n(none)\n\n## Blocked\n(none)\n\n## Needs you\n(none)\n");
});

test("writeDigest writes digest.md in the factory dir", () => {
  // Arrange + Act: write the digest of a factory
  const root = setup({ s1: "phase: build\nrun: on" });
  writeDigest(root);
  // Assert: the file holds exactly what the renderer gives
  assert.equal(readFileSync(join(factoryDir(root), "digest.md"), "utf8"), digestOf(root));
});

test("a repo with no factory gets no file and no directory", () => {
  // Arrange: a repo with no factory
  const root = mkdtempSync(join(tmpdir(), "digest-"));
  roots.push(root);
  // Act
  writeDigest(root);
  // Assert: no .harness directory appears
  assert.equal(existsSync(join(root, ".harness")), false);
});

test("unchanged content is not rewritten, changed content is", () => {
  // Arrange: a written digest with its mtime set far in the past
  const root = setup({ s1: "phase: build\nrun: on" });
  writeDigest(root);
  const file = join(factoryDir(root), "digest.md");
  const old = new Date("2020-01-01T00:00:00Z");
  utimesSync(file, old, old);
  // Act + Assert: same content leaves the mtime alone
  writeDigest(root);
  assert.equal(statSync(file).mtimeMs, old.getTime());
  // Act + Assert: changed content is rewritten
  put(join(sliceDir(root, "m1", "s1"), "state.md"), "---\nphase: review\nrun: on\nready: review\n---\n");
  writeDigest(root);
  assert.match(readFileSync(file, "utf8"), /review is clean/);
});
