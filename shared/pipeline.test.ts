import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PHASES,
  DONE_DESCRIPTION,
  MACHINE_SOURCE,
  findRef,
  matchesRef,
  phasePrompt,
  phaseSkills,
  STEP_PHASES,
  stepSkills,
  withoutSkillsync,
  type CatalogSkill,
} from "./pipeline";
import { LOOP_STEPS } from "./initiative-loop";

const skill: CatalogSkill = {
  name: "vercel-react-best-practices",
  folder: "react-best-practices",
  description: "",
  source: "vercel-labs-agent-skills",
  kind: "skill",
};

test("a ref matches a catalog skill by its name or its folder on the same source", () => {
  assert.equal(matchesRef(skill, { name: "vercel-react-best-practices", source: skill.source }), true);
  assert.equal(matchesRef(skill, { name: "react-best-practices", source: skill.source }), true);
  assert.equal(matchesRef(skill, { name: "something-else", source: skill.source }), false);
});

test("a ref on a different source does not match", () => {
  assert.equal(matchesRef(skill, { name: skill.name, source: "installed" }), false);
  assert.equal(matchesRef(skill, { name: skill.folder, source: "installed" }), false);
});

test("findRef picks the name match over a folder match on the same source", () => {
  const byFolder: CatalogSkill = { ...skill, name: "other", folder: "vercel-react-best-practices" };
  const catalog = [byFolder, skill];

  assert.equal(findRef(catalog, { name: "vercel-react-best-practices", source: skill.source }), skill);
  assert.equal(findRef(catalog, { name: "react-best-practices", source: skill.source }), skill);
  assert.equal(findRef(catalog, { name: "missing", source: skill.source }), undefined);
});

test("saved phases drop retired skillsync skills but keep skills from connected sources", () => {
  const saved = {
    id: "review",
    label: "Review",
    runs: { name: "ss-review", source: MACHINE_SOURCE },
    extras: [
      { name: "ss-security-audit", source: MACHINE_SOURCE, required: true },
      { name: "tdd", source: MACHINE_SOURCE },
      { name: "react-review", source: "team-skills" },
      { name: "ss-custom", source: "team-skills" },
    ],
    then: "pass",
  };
  assert.deepEqual(withoutSkillsync(saved), {
    ...saved,
    runs: null,
    extras: [
      { name: "react-review", source: "team-skills" },
      { name: "ss-custom", source: "team-skills" },
    ],
  });
  const kept = { ...saved, runs: { name: "my-reviewer", source: "team-skills" }, extras: [] };
  assert.deepEqual(withoutSkillsync(kept), kept);
});

test("the default pipeline runs built-in steps and never names a skillsync command", () => {
  const ticket = { key: "KEY-1", title: "Example", url: null };
  for (const phase of DEFAULT_PHASES) {
    assert.equal(phase.runs, null);
    assert.doesNotMatch(phasePrompt(phase, ticket), /\/ss-|skillsync/);
  }
  const done = DEFAULT_PHASES.find((p) => p.id === "done");
  assert.ok(done);
  assert.equal(phasePrompt(done, ticket), DONE_DESCRIPTION);
});

test("a picked phase skill is named in the prompt, and auto Plan skips approval", () => {
  const ticket = { key: "KEY-1", title: "Example", url: null };
  const plan = { ...DEFAULT_PHASES[0], runs: { name: "my-planner", source: "team-skills" }, then: "auto" as const };
  const prompt = phasePrompt(plan, ticket);
  assert.match(prompt, /Also use these skills: my-planner\./);
  assert.match(prompt, /without waiting/);
});

test("implement and fix both load the saved Implement extras", () => {
  const extras = [{ name: "react-review", source: "team-skills" }];
  const phases = DEFAULT_PHASES.map((p) => (p.id === "implement" ? { ...p, extras } : p));
  assert.deepEqual(stepSkills("implement", phases), extras);
  assert.deepEqual(stepSkills("fix", phases), extras);
});

test("diagnose loads the saved Plan extras", () => {
  const extras = [{ name: "repro-helper", source: "team-skills" }];
  const phases = DEFAULT_PHASES.map((p) => (p.id === "plan" ? { ...p, extras } : p));
  assert.deepEqual(stepSkills("diagnose", phases), stepSkills("plan", phases));
  assert.deepEqual(stepSkills("diagnose", phases), extras);
});

test("plan and pr load no extras with the default phases", () => {
  assert.deepEqual(stepSkills("plan", DEFAULT_PHASES), []);
  assert.deepEqual(stepSkills("pr", DEFAULT_PHASES), []);
});

test("a custom extra added to Done shows up for pr", () => {
  const extras = [{ name: "release-notes", source: "team-skills" }];
  const phases = DEFAULT_PHASES.map((p) => (p.id === "done" ? { ...p, extras } : p));
  assert.deepEqual(stepSkills("pr", phases), extras);
});

test("saved phases missing Review fall back to the default Review phase", () => {
  const phases = DEFAULT_PHASES.filter((p) => p.id !== "review");
  assert.deepEqual(stepSkills("review", phases), []);
});

test("a Review phase with runs set loads only its extras, never the runs skill", () => {
  const runs = { name: "my-reviewer", source: "team-skills" };
  const extras = [{ name: "react-review", source: "team-skills" }];
  const phases = DEFAULT_PHASES.map((p) => (p.id === "review" ? { ...p, runs, extras } : p));
  const skills = stepSkills("review", phases);
  assert.deepEqual(skills, extras);
  assert.ok(!skills.some((s) => s.name === runs.name));
});

test("every loop step loads its mapped phase's extras", () => {
  const phases = DEFAULT_PHASES.map((p) => ({ ...p, extras: [{ name: `${p.id}-extra`, source: "team-skills" }] }));
  for (const step of LOOP_STEPS) {
    const phase = phases.find((p) => p.id === STEP_PHASES[step]);
    assert.ok(phase);
    assert.deepEqual(stepSkills(step, phases), phaseSkills(phase).extras);
  }
});
