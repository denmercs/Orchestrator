import assert from "node:assert/strict";
import { test } from "node:test";
import { type Factory, type FactorySlice, parseSeat, parseSliceState, runnableSlices } from "./factory";

test("parseSliceState reads an empty frontmatter as an idle scout at the spec phase", () => {
  assert.deepEqual(parseSliceState({}), {
    phase: "spec",
    seat: "",
    agent: "",
    attempt: 0,
    worktree: "",
    story: "",
    kind: "scout",
    depends: [],
    run: false,
    design: false,
    ready: "",
    approve: "",
    pr: "",
  });
});

test("parseSliceState reads every field", () => {
  assert.deepEqual(
    parseSliceState({
      phase: "build",
      seat: "engineer",
      agent: "a1",
      attempt: "2",
      worktree: "/w",
      story: "S1",
      kind: "ship",
      depends: "a, b",
      run: "on",
      design: "on",
      ready: "ci",
      approve: "plan",
      pr: "42",
    }),
    {
      phase: "build",
      seat: "engineer",
      agent: "a1",
      attempt: 2,
      worktree: "/w",
      story: "S1",
      kind: "ship",
      depends: ["a", "b"],
      run: true,
      design: true,
      ready: "ci",
      approve: "plan",
      pr: "42",
    },
  );
});

test("parseSliceState falls back on unknown values", () => {
  const state = parseSliceState({ phase: "nope", kind: "x", attempt: "many", run: "yes" });
  assert.deepEqual([state.phase, state.kind, state.attempt, state.run], ["spec", "scout", 0, false]);
  assert.equal(parseSliceState({ attempt: "-1" }).attempt, 0);
  assert.equal(parseSliceState({ attempt: "1.5" }).attempt, 0);
  const odd = parseSliceState({ ready: "soon", approve: "yes" });
  assert.deepEqual([odd.ready, odd.approve], ["", ""]);
  assert.equal(parseSliceState({ ready: "review" }).ready, "review");
});

test("parseSeat reads profile, skills and agent from frontmatter and notes from the body", () => {
  assert.deepEqual(parseSeat("engineer", { profile: "p", skills: "tdd, review", agent: "a" }, "Notes"), {
    role: "engineer",
    profile: "p",
    skills: ["tdd", "review"],
    agent: "a",
    notes: "Notes",
  });
});

const slice = (id: string, mission: string, fields: Record<string, string> = {}): FactorySlice => ({
  id,
  mission,
  state: parseSliceState(fields),
  spec: "",
  design: "",
  proof: "",
});
const factoryOf = (...missions: [string, FactorySlice[]][]): Factory => ({
  project: "",
  manager: { agent: "" },
  culture: "",
  seats: [],
  missions: missions.map(([id, slices]) => ({ id, outcome: "", slices })),
});

const ids = (factory: Factory) => runnableSlices(factory).map((found) => found.id);
const finished = (id: string, mission: string, ready = "review") => ({ ...slice(id, mission, { run: "on", ready }), proof: "Proof." });

test("runnableSlices is empty when no slice is run: on", () => {
  assert.deepEqual(runnableSlices(factoryOf(["m1", [slice("a", "m1"), slice("b", "m1", { run: "off" })]])), []);
});

test("runnableSlices returns every run: on slice that is not ready, in mission then slice order", () => {
  const factory = factoryOf(
    ["m1", [slice("x", "m1"), slice("a", "m1", { run: "on" }), slice("r", "m1", { run: "on", ready: "review" }), slice("b", "m1", { run: "on" })]],
    ["m2", [slice("c", "m2", { run: "on" })]],
  );
  // m1 has no finished slice yet, so m2 waits behind it
  assert.deepEqual(ids(factory), ["a", "b"]);
  assert.deepEqual(ids(factoryOf(["m1", [finished("a", "m1")]], ["m2", [slice("c", "m2", { run: "on" }), slice("d", "m2", { run: "on" })]])), ["c", "d"]);
});

test("runnableSlices blocks a slice whose dependency has an empty proof", () => {
  const dependency = { ...slice("a", "m1", { run: "on", ready: "review" }), proof: "" };
  assert.deepEqual(ids(factoryOf(["m1", [dependency, slice("b", "m1", { run: "on", depends: "a" })]])), []);
});

test("runnableSlices blocks a slice whose dependency has proof but is not ready", () => {
  const dependency = { ...slice("a", "m1", { run: "on" }), proof: "Proof." };
  assert.deepEqual(ids(factoryOf(["m1", [dependency, slice("b", "m1", { run: "on", depends: "a" })]])), ["a"]);
});

test("runnableSlices lets a slice run once its dependency has proof and is ready for review or ci", () => {
  for (const ready of ["review", "ci"]) {
    assert.deepEqual(ids(factoryOf(["m1", [finished("a", "m1", ready), slice("b", "m1", { run: "on", depends: "a" })]])), ["b"]);
  }
});

test("runnableSlices blocks a slice that depends on an unknown id", () => {
  assert.deepEqual(ids(factoryOf(["m1", [slice("b", "m1", { run: "on", depends: "ghost" })]])), []);
});

test("runnableSlices holds a later mission while an earlier mission is open", () => {
  const later = slice("c", "m2", { run: "on" });
  assert.deepEqual(ids(factoryOf(["m1", [slice("a", "m1", { run: "on" })]], ["m2", [later]])), ["a"]);
  assert.deepEqual(ids(factoryOf(["m1", [slice("a", "m1", { run: "on", ready: "blocked" })]], ["m2", [later]])), []);
});

test("runnableSlices does not hold a later mission for an earlier mission that is done or idle", () => {
  const later = slice("c", "m2", { run: "on" });
  assert.deepEqual(ids(factoryOf(["m1", [finished("a", "m1")]], ["m2", [later]])), ["c"]);
  assert.deepEqual(ids(factoryOf(["m1", [slice("a", "m1")]], ["m2", [later]])), ["c"]);
});
