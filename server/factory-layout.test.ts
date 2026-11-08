import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { factoryDir, factoryTick, readFactory, sliceDir, writeSliceState } from "./factory-layout";

const put = (file: string, text: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};

test("readFactory reads every file of the tree into typed values", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-layout-"));
  try {
    const home = factoryDir(root);
    put(join(home, "project.md"), "# Project\n\nShip the thing.\n");
    put(join(home, "manager.md"), "---\nagent: agent-m\n---\n\nManager notes.\n");
    put(join(home, "culture.md"), "Small diffs.\n");
    put(join(home, "seats", "builder.md"), "---\nprofile: fast\nskills: tdd, review\nagent: agent-b\n---\n\nBuilds.\n");
    put(join(home, "missions", "01-first", "mission.md"), "# Outcome\n\nFirst outcome.\n");
    const slice = sliceDir(root, "01-first", "01-a");
    put(join(slice, "spec.md"), "the spec\n");
    put(join(slice, "design.md"), "the design\n");
    put(join(slice, "proof.md"), "the proof\n");
    put(join(slice, "state.md"), "---\nphase: build\nrun: on\nkind: ship\nattempt: 2\ndepends: x, y\nagent: agent-1\n---\n");

    const factory = readFactory(root);
    assert.equal(factory.project, "# Project\n\nShip the thing.");
    assert.deepEqual(factory.manager, { agent: "agent-m" });
    assert.equal(factory.culture, "Small diffs.");
    assert.deepEqual(factory.seats, [
      { role: "builder", profile: "fast", skills: ["tdd", "review"], agent: "agent-b", notes: "Builds." },
    ]);
    assert.equal(factory.missions.length, 1);
    assert.equal(factory.missions[0].id, "01-first");
    assert.equal(factory.missions[0].outcome, "# Outcome\n\nFirst outcome.");
    const [read] = factory.missions[0].slices;
    assert.equal(read.id, "01-a");
    assert.equal(read.mission, "01-first");
    assert.deepEqual([read.spec, read.design, read.proof], ["the spec", "the design", "the proof"]);
    assert.equal(read.state.phase, "build");
    assert.equal(read.state.run, true);
    assert.equal(read.state.kind, "ship");
    assert.equal(read.state.attempt, 2);
    assert.deepEqual(read.state.depends, ["x", "y"]);
    assert.equal(read.state.agent, "agent-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a slice with only state.md reads empty prose; one with no state.md reads the default state", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-layout-"));
  try {
    put(join(sliceDir(root, "01-m", "01-a"), "state.md"), "---\nphase: test\n---\n");
    mkdirSync(sliceDir(root, "01-m", "02-b"), { recursive: true });
    const [a, b] = readFactory(root).missions[0].slices;
    assert.deepEqual([a.spec, a.design, a.proof, a.state.phase], ["", "", "", "test"]);
    assert.deepEqual([b.spec, b.state.phase, b.state.run, b.state.kind], ["", "spec", false, "scout"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a factory with no project, manager, culture or seats reads those as empty", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-layout-"));
  try {
    put(join(sliceDir(root, "01-m", "01-a"), "state.md"), "---\nrun: on\n---\n");
    const factory = readFactory(root);
    assert.equal(factory.project, "");
    assert.equal(factory.culture, "");
    assert.equal(factory.manager.agent, "");
    assert.deepEqual(factory.seats, []);
    assert.equal(factory.missions.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a repo with no .harness/factory reads as an empty factory and the tick returns null", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-layout-"));
  try {
    assert.deepEqual(readFactory(root), { project: "", manager: { agent: "" }, culture: "", seats: [], missions: [] });
    assert.equal(factoryTick(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("factoryTick returns the first runnable slice", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-layout-"));
  try {
    put(join(sliceDir(root, "01-m", "01-a"), "state.md"), "---\nphase: build\n---\n");
    put(join(sliceDir(root, "01-m", "02-b"), "state.md"), "---\nrun: on\n---\n");
    assert.equal(factoryTick(root)?.id, "02-b");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeSliceState sets and removes machine fields and leaves every other line alone", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-layout-"));
  try {
    const file = join(sliceDir(root, "01-first", "01-a"), "state.md");
    put(file, "---\nphase: spec\nagent: old\nworktree: /tmp/w\nrun: on\n---\n\nNotes stay.\n");
    writeSliceState(root, "01-first", "01-a", { phase: "build", agent: "new", worktree: null, depends: ["a", "b"], design: true });
    assert.equal(
      readFileSync(file, "utf8"),
      "---\nphase: build\nagent: new\nrun: on\ndepends: a, b\ndesign: on\n---\n\nNotes stay.\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeSliceState creates state.md in a slice folder that has none", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-layout-"));
  try {
    mkdirSync(sliceDir(root, "01-m", "01-a"), { recursive: true });
    writeSliceState(root, "01-m", "01-a", { phase: "build", run: true });
    const [slice] = readFactory(root).missions[0].slices;
    assert.equal(slice.state.phase, "build");
    assert.equal(slice.state.run, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
