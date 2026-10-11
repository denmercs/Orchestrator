import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PHASES, MACHINE_SOURCE, type Phase, type SkillSource, type SourceStatus } from "../shared/pipeline";
import { ADD_MODES, DRAWER_TABS, draftKind, handoffChip, handoffChips, nextOpen, phaseSummary, repoHint, SCOPE_LABEL, sourceRows, THEN_OPTION_LABEL } from "./pipeline-drawer-model";

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

test("handoffChips: one chip under every card, so Done ends on the merge chip", () => {
  assert.deepEqual(
    handoffChips(DEFAULT_PHASES).map((c) => c.label),
    ["wait for you → Implement", "auto → Review", "on PASS → Done", "on merge"],
  );
});

function src(rest: Partial<SkillSource> = {}): SkillSource {
  return { id: "s1", label: "Team skills", location: "owner/repo", kind: "team", enabled: true, pin: "1234567890abcdef", ...rest };
}
function status(rest: Partial<SourceStatus> = {}): SourceStatus {
  return { id: "s1", ok: true, error: null, commit: "abc1234def5678", skillCount: 3, ...rest };
}

test("SCOPE_LABEL: Team, Personal, Imported", () => {
  assert.deepEqual(SCOPE_LABEL, { team: "Team", personal: "Personal", imported: "Imported" });
});

test("sourceRows: the machine row comes first, global and fixed", () => {
  const [machine] = sourceRows([], [], 5);
  assert.deepEqual(machine, {
    id: MACHINE_SOURCE,
    name: "This machine",
    icon: "machine",
    scope: "Global",
    detail: "~/.claude/skills · ~/.agents/skills · ~/.claude/commands",
    meta: "5 skills · already global, nothing copied",
    fixed: true,
    error: false,
  });
  assert.equal(sourceRows([], [], 1)[0]?.meta, "1 skill · already global, nothing copied");
});

test("sourceRows: a pinned source is a github row with the short status commit", () => {
  const rows = sourceRows([src()], [status()], 0);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], {
    id: "s1",
    name: "Team skills",
    icon: "github",
    scope: "Team",
    detail: "owner/repo",
    meta: "Pinned @ abc1234 · 3 skills",
    fixed: false,
    error: false,
  });
});

test("sourceRows: with no status commit the pin is shortened, and the count is 0", () => {
  assert.equal(sourceRows([src()], [], 0)[1]?.meta, "Pinned @ 1234567 · 0 skills");
});

test("sourceRows: an unpinned source is a folder row read live, with its own scope label", () => {
  const row = sourceRows([src({ pin: null, kind: "personal", location: "/x" })], [status({ commit: null, skillCount: 1 })], 0)[1];
  assert.equal(row?.icon, "folder");
  assert.equal(row?.scope, "Personal");
  assert.equal(row?.detail, "/x");
  assert.equal(row?.meta, "Folder · read live · 1 skill");
});

test("sourceRows: a turned-off source adds off", () => {
  assert.equal(sourceRows([src({ enabled: false })], [status()], 0)[1]?.meta, "Pinned @ abc1234 · 3 skills · off");
});

test("sourceRows: a failing status shows its error in place of the count and flags the row", () => {
  const row = sourceRows([src({ pin: null })], [status({ ok: false, error: "not a folder", skillCount: 0 })], 0)[1];
  assert.equal(row?.meta, "Folder · read live · not a folder");
  assert.equal(row?.error, true);
});

test("draftKind: a draft starting with / or ~ is a folder, anything else is github", () => {
  assert.equal(draftKind("/x"), "folder");
  assert.equal(draftKind("~/x"), "folder");
  assert.equal(draftKind("owner/repo"), "github");
  assert.equal(draftKind("https://github.com/owner/repo"), "github");
});

test("draftKind: trims first, and an empty or blank draft defaults to github", () => {
  assert.equal(draftKind("  /x"), "folder");
  assert.equal(draftKind(""), "github");
  assert.equal(draftKind("   "), "github");
});

test("repoHint: empty, folder and git wording", () => {
  assert.equal(repoHint(""), "Git repos are cloned and pinned to the current commit. Folders are read live.");
  assert.equal(repoHint("   "), "Git repos are cloned and pinned to the current commit. Folders are read live.");
  assert.equal(repoHint("/x"), "Folder: read live, changes show up on Reload.");
  assert.equal(repoHint("~/x"), "Folder: read live, changes show up on Reload.");
  assert.equal(repoHint("owner/repo"), "Git repo: cloned and pinned to the current commit.");
});

test("ADD_MODES: Connect repo then Search skills.sh", () => {
  assert.deepEqual(ADD_MODES, [
    { id: "repo", label: "Connect repo" },
    { id: "search", label: "Search skills.sh" },
  ]);
});
