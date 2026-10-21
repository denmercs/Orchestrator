import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PHASES, fixPrompt, phasePrompt } from "./pipeline";
import { LOOP_STEPS, stepPrompt, type Cycle, type StoryContext } from "./story-method";
import { TESTING_SKILL, TESTING_SKILL_NAME, TESTING_SKILL_PATH, TESTING_STEPS, testingLine, usesTestingSkill } from "./testing-skill";

const story: StoryContext = {
  id: "S1",
  title: "Add search",
  body: "Users can search.",
  ticketKey: null,
  ticketUrl: null,
  storyFile: null,
  storiesDir: null,
  phaseLabel: null,
  phaseTitle: null,
  architectureFile: null,
  initiativeTitle: null,
  initiativeFile: null,
  branch: "feature/s1",
  base: "origin/main",
};
const cycles: Cycle[] = [
  { number: 1, name: "a", line: "- [ ] Cycle 1 — a: t → c", done: false },
  { number: 2, name: "b", line: "- [ ] Cycle 2 — b: t → c", done: false },
];
const PATH = TESTING_SKILL_PATH;
const count = (text: string, needle: string) => text.split(needle).length - 1;

test("the built-in skill is a valid SKILL.md with its name and a description", () => {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(TESTING_SKILL)?.[1] ?? "";
  assert.match(front, new RegExp(`^name: ${TESTING_SKILL_NAME}$`, "m"));
  assert.match(front, /^description: \S.+$/m);
  assert.equal(PATH, ".harness/skills/testing-guidelines/SKILL.md");
});

test("the built-in skill keeps every substantive rule of the guidelines it replaces", () => {
  for (const rule of [
    /never `require\(\)`/,
    /No `data-testid`/,
    /No false positives/,
    /revert the production change/,
    /`userEvent`, not `fireEvent`/,
    /Query through `screen`/,
    /waitFor/,
    /No DOM traversal/,
    /Query priority/,
    /jest\.clearAllMocks\(\)/,
    /Mock only external boundaries/,
    /jest\.MockedFunction/,
    /useFakeTimers/,
    /localStorage/,
    /renderHook/,
    /jest-axe/,
    /Snapshots sparingly/,
    /createRegistry/,
    /@wordpress\/api-fetch/,
    /Arrange, Act, Assert/,
    /## Checklist/,
  ]) {
    assert.match(TESTING_SKILL, rule);
  }
});

test("the built-in skill is trimmed: no table of contents, no team-specific asks, well under the 29.5K original", () => {
  assert.doesNotMatch(TESTING_SKILL, /Table of Contents|team lead|Questions or Issues/i);
  assert.ok(TESTING_SKILL.length < 10_000, `${TESTING_SKILL.length} chars`);
});

test("only Implement and Review use the testing skill", () => {
  assert.deepEqual([...TESTING_STEPS], ["implement", "review"]);
  assert.deepEqual(
    LOOP_STEPS.filter((step) => usesTestingSkill(step)),
    ["implement", "review"],
  );
  assert.equal(testingLine("plan", PATH), "");
  assert.equal(testingLine("fix", PATH), "");
  assert.equal(testingLine("implement", undefined), "");
  assert.match(testingLine("implement", PATH), /before you write a test/);
  assert.match(testingLine("review", PATH), /Judge every new or changed test/);
});

test("every Implement variant and both Review rounds point at the skill once", () => {
  const prompts = {
    cycle: stepPrompt("implement", story, { round: 1, cycle: cycles[0], plan: "p", testingSkill: PATH }),
    whole: stepPrompt("implement", story, { round: 1, testingSkill: PATH }),
    findingsFix: stepPrompt("implement", story, { round: 2, testingSkill: PATH }),
    review: stepPrompt("review", story, { round: 1, testingSkill: PATH }),
    rereview: stepPrompt("review", story, { round: 2, testingSkill: PATH }),
  };
  for (const [name, prompt] of Object.entries(prompts)) {
    assert.equal(count(prompt, `\`${PATH}\``), 1, name);
  }
  assert.match(prompts.review, /Judge every new or changed test/);
});

test("the subagent parent puts the pointer inside the cycle brief each subagent gets", () => {
  const prompt = stepPrompt("implement", story, { round: 1, cycles, plan: "p", testingSkill: PATH });
  assert.equal(count(prompt, `\`${PATH}\``), 1);
  const brief = prompt.slice(prompt.indexOf("\n## Cycle brief\n"));
  assert.match(brief.split("\n\n")[0], new RegExp(PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Plan, Diagnose, the PR step and Fix CI never name the skill, even when handed one", () => {
  for (const step of ["plan", "diagnose", "pr", "fix"] as const) {
    const prompt = stepPrompt(step, story, { round: 1, testingSkill: PATH, failing: "lint" });
    assert.doesNotMatch(prompt, /testing guidelines|testing-guidelines/, step);
  }
});

test("no testing skill leaves the prompts unchanged", () => {
  for (const extra of [{ round: 1 }, { round: 2 }, { round: 1, cycles, plan: "p" }, { round: 1, cycle: cycles[0], plan: "p" }]) {
    assert.doesNotMatch(stepPrompt("implement", story, extra), /testing guidelines/);
  }
  assert.doesNotMatch(stepPrompt("review", story, { round: 1 }), /testing guidelines/);
});

test("the Story pipeline passes it to Implement and Review, and Fix CI ignores it", () => {
  const ticket = { key: "QP-1", title: "Search", url: "https://example.test/QP-1" };
  const phase = (id: string) => DEFAULT_PHASES.find((p) => p.id === id)!;
  assert.match(phasePrompt(phase("implement"), ticket, { testingSkill: PATH }), /before you write a test/);
  assert.match(phasePrompt(phase("review"), ticket, { testingSkill: PATH }), /Judge every new or changed test/);
  assert.doesNotMatch(phasePrompt(phase("plan"), ticket, { testingSkill: PATH }), /testing guidelines/);
  assert.doesNotMatch(fixPrompt(phase("implement"), ticket, { failing: "lint", testingSkill: PATH }), /testing guidelines/);
});
