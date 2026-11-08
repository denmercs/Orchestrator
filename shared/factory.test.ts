import assert from "node:assert/strict";
import { test } from "node:test";
import { type Factory, type FactorySlice, parseSeat, parseSliceState, runnableSlice } from "./factory";

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
    },
  );
});

test("parseSliceState falls back on unknown values", () => {
  const state = parseSliceState({ phase: "nope", kind: "x", attempt: "many", run: "yes" });
  assert.deepEqual([state.phase, state.kind, state.attempt, state.run], ["spec", "scout", 0, false]);
  assert.equal(parseSliceState({ attempt: "-1" }).attempt, 0);
  assert.equal(parseSliceState({ attempt: "1.5" }).attempt, 0);
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

test("runnableSlice is null when no slice is run: on", () => {
  assert.equal(runnableSlice(factoryOf(["m1", [slice("a", "m1"), slice("b", "m1", { run: "off" })]])), null);
});

test("runnableSlice ignores depends on an unfinished slice", () => {
  const dependent = slice("b", "m1", { run: "on", depends: "a" });
  assert.equal(runnableSlice(factoryOf(["m1", [slice("a", "m1"), dependent]])), dependent);
});

test("runnableSlice returns only the first run: on slice, in mission then slice order", () => {
  const first = slice("a", "m1", { run: "on" });
  const second = slice("b", "m2", { run: "on" });
  assert.equal(runnableSlice(factoryOf(["m1", [slice("x", "m1"), first]], ["m2", [second]])), first);
});
