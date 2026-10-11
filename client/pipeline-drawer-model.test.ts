import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PHASES, type Phase } from "../shared/pipeline";
import { DRAWER_TABS, handoffChip, nextOpen, phaseSummary, THEN_OPTION_LABEL } from "./pipeline-drawer-model";

function phase(id: Phase["id"], rest: Partial<Phase> = {}): Phase {
  const base = DEFAULT_PHASES.find((p) => p.id === id) as Phase;
  return { ...base, ...rest };
}

test("phaseSummary: runs skill name and extras joined after two spaces and a plus", () => {
  const summary = phaseSummary(
    phase("plan", {
      runs: { name: "ss-plan", source: "installed" },
      extras: [
        { name: "anti-slop", source: "installed" },
        { name: "grill-me", source: "installed" },
      ],
    }),
  );
  assert.deepEqual(summary, { runs: "ss-plan", extras: "  + anti-slop, grill-me" });
});

test("phaseSummary: built-in step with no extras", () => {
  assert.deepEqual(phaseSummary(phase("implement")), { runs: "built-in step", extras: "" });
});

test("phaseSummary: required defaults are included even if the saved phase dropped them", () => {
  const required = DEFAULT_PHASES.flatMap((p) => p.extras.filter((e) => e.required).map((e) => ({ p, e })));
  for (const { p, e } of required) {
    assert.ok(phaseSummary({ ...p, extras: [] }).extras.includes(e.name));
  }
});

test("handoffChip: auto names the next phase and is marked auto", () => {
  assert.deepEqual(handoffChip(DEFAULT_PHASES, 1), { label: "auto → Review", auto: true });
});

test("handoffChip: you waits for the next phase", () => {
  assert.deepEqual(handoffChip(DEFAULT_PHASES, 0), { label: "wait for you → Implement", auto: false });
});

test("handoffChip: pass names the next phase", () => {
  assert.deepEqual(handoffChip(DEFAULT_PHASES, 2), { label: "on PASS → Done", auto: false });
});

test("handoffChip: merge has no arrow, and a missing next phase does not throw", () => {
  assert.deepEqual(handoffChip(DEFAULT_PHASES, 3), { label: "on merge", auto: false });
  const last = [phase("plan", { then: "auto" })];
  assert.deepEqual(handoffChip(last, 0), { label: "auto", auto: true });
});

test("THEN_OPTION_LABEL: plain words, no glyphs", () => {
  assert.deepEqual(THEN_OPTION_LABEL, { auto: "auto", you: "wait for you", pass: "on PASS", merge: "on merge" });
});

test("DRAWER_TABS: Phases, Context, Sources in order", () => {
  assert.deepEqual(DRAWER_TABS, [
    { id: "phases", label: "Phases" },
    { id: "context", label: "Context" },
    { id: "sources", label: "Sources" },
  ]);
});

test("nextOpen: same id closes, another id opens it, one open at a time", () => {
  assert.equal(nextOpen(null, "plan"), "plan");
  assert.equal(nextOpen("plan", "plan"), null);
  assert.equal(nextOpen("plan", "review"), "review");
});
