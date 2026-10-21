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
  withKitPlanDefault,
  withoutSkillsync,
  pipelineSettings,
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

test("migrating from v3 bumps saved Plan, Implement and Review phases with runs: null to the kit's skills", () => {
  const migrate = pipelineSettings.migrate as (values: unknown, from: number) => { phases: unknown[] };
  const saved = {
    enabled: true,
    phases: [
      { id: "plan", label: "Plan", runs: null, extras: [], then: "you" },
      { id: "implement", label: "Implement", runs: null, extras: [], then: "auto" },
      { id: "review", label: "Review", runs: null, extras: [], then: "pass" },
      { id: "done", label: "Done", runs: null, extras: [], then: "merge" },
    ],
    reviewRounds: 5,
    maxFixes: 2,
    closeOnMerge: true,
    sources: [],
  };
  const result = migrate(saved, 3) as { phases: Array<{ id: string; runs: unknown }>; reviewRounds: number };
  assert.deepEqual(result.phases.find((p) => p.id === "plan")?.runs, { name: "story-plan", source: "kit" });
  assert.deepEqual(result.phases.find((p) => p.id === "implement")?.runs, { name: "story-impl", source: "kit" });
  assert.deepEqual(result.phases.find((p) => p.id === "review")?.runs, { name: "story-review", source: "kit" });
  assert.equal(result.phases.find((p) => p.id === "done")?.runs, null);
  assert.equal(result.reviewRounds, 5);
});

test("withKitPlanDefault leaves a Plan phase alone when runs is already set", () => {
  const plan = { id: "plan", label: "Plan", runs: { name: "my-planner", source: "team-skills" }, extras: [], then: "you" };
  assert.deepEqual(withKitPlanDefault(plan), plan);
  const review = { id: "review", label: "Review", runs: null, extras: [], then: "pass" };
  assert.deepEqual(withKitPlanDefault(review), review);
});

test("the default pipeline uses the kit's story-plan, story-impl and story-review skills and a built-in Done, never a skillsync command", () => {
  const ticket = { key: "KEY-1", title: "Example", url: null };
  for (const phase of DEFAULT_PHASES) {
    const kitSkills: Record<string, string> = { plan: "story-plan", implement: "story-impl", review: "story-review" };
    const kitSkill = kitSkills[phase.id];
    if (kitSkill) {
      assert.deepEqual(phase.runs, { name: kitSkill, source: "kit" });
    } else {
      assert.equal(phase.runs, null);
    }
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
