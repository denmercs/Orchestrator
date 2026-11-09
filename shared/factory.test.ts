import assert from "node:assert/strict";
import { test } from "node:test";
import { type Factory, type FactorySlice, parseSeat, heldBy, mergeWatch, parseSliceState, runnableSlices } from "./factory";

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
    held: "",
    jira: "",
    merged: "",
    workspace: "",
    steered: "",
    close: false,
    archived: false,
    archive_held: false,
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
      held: "blocked dependency a",
      jira: "ABC-12",
      merged: "2026-11-08T10:00:00Z",
      workspace: "wks_1",
      steered: "plan",
      close: "on",
      archived: "on",
      archive_held: "on",
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
      held: "blocked dependency a",
      jira: "ABC-12",
      merged: "2026-11-08T10:00:00Z",
      workspace: "wks_1",
      steered: "plan",
      close: true,
      archived: true,
      archive_held: true,
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

test("parseSliceState keeps a valid ticket key and drops anything else", () => {
  assert.equal(parseSliceState({ jira: "ABC-12" }).jira, "ABC-12");
  assert.equal(parseSliceState({ jira: "nope" }).jira, "");
  assert.equal(parseSliceState({ jira: "abc-12" }).jira, "");
  assert.equal(parseSliceState({ merged: "2026-11-08T10:00:00Z" }).merged, "2026-11-08T10:00:00Z");
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

test("heldBy names a blocked or unknown dependency, and nothing for one still in progress", () => {
  const blocked = slice("a", "m1", { run: "on", ready: "blocked" });
  const working = slice("w", "m1", { run: "on" });
  const held = (fields: Record<string, string>, mission = { id: "m1", outcome: "", slices: [blocked, working] }) =>
    heldBy(slice("b", "m1", fields), mission);
  assert.equal(held({ run: "on", depends: "w, a" }), "blocked dependency a");
  assert.equal(held({ run: "on", depends: "ghost" }), "unknown dependency ghost");
  assert.equal(held({ run: "on", depends: "w" }), null);
  // An idle or ready slice is not held, whatever it depends on.
  assert.equal(held({ depends: "a" }), null);
  assert.equal(held({ run: "on", ready: "blocked", depends: "a" }), null);
});

test("heldBy names a dependency loop, a self-dependency, and an idle dependency nothing will run", () => {
  const a = slice("a", "m1", { run: "on", depends: "b" });
  const b = slice("b", "m1", { run: "on", depends: "c" });
  const c = slice("c", "m1", { run: "on", depends: "a" });
  const idle = slice("idle", "m1", {});
  const doneIdle = slice("doneIdle", "m1", { ready: "review" });
  doneIdle.proof = "ran it";
  const mission = { id: "m1", outcome: "", slices: [a, b, c, idle, doneIdle] };
  assert.equal(heldBy(a, mission), "dependency loop a -> b -> c -> a");
  assert.equal(heldBy(b, mission), "dependency loop b -> c -> a -> b");
  assert.equal(heldBy(slice("s", "m1", { run: "on", depends: "s" }), { ...mission, slices: [slice("s", "m1", { run: "on", depends: "s" })] }), "dependency loop s -> s");
  assert.equal(heldBy(slice("x", "m1", { run: "on", depends: "idle" }), mission), "idle dependency idle");
  // A done slice that is not run: on is finished, not idle.
  assert.equal(heldBy(slice("y", "m1", { run: "on", depends: "doneIdle" }), mission), null);
  // A chain that ends in a loop it is not part of is a normal wait on the loop's own slices.
  assert.equal(heldBy(slice("z", "m1", { run: "on", depends: "a" }), mission), null);
});

test("mergeWatch returns only ship slices that are ready at ci with a pr and not yet merged", () => {
  const watched = slice("a", "m1", { kind: "ship", ready: "ci", pr: "7" });
  const factory = factoryOf(
    ["m1", [watched, slice("b", "m1", { kind: "ship", ready: "ci", pr: "8", merged: "2026-11-08T10:00:00Z" })]],
    [
      "m2",
      [
        slice("c", "m2", { kind: "scout", ready: "ci", pr: "9" }),
        slice("d", "m2", { kind: "ship", ready: "review", pr: "10" }),
        slice("e", "m2", { kind: "ship", ready: "ci" }),
        slice("f", "m2", { kind: "ship", ready: "blocked", pr: "11" }),
      ],
    ],
  );
  assert.deepEqual(mergeWatch(factory), [watched]);
});
