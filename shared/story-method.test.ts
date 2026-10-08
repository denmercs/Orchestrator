import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOOP_STEPS,
  afterImplement,
  implementCommitMessage,
  readCycles,
  readMarker,
  readSection,
  stepPrompt,
  writeMarker,
  type StoryContext,
} from "./story-method";

const story: StoryContext = {
  id: "S1",
  title: "Add search",
  body: "Users can search.",
  ticketUrl: null,
  storyFile: "/repo/.harness/initiatives/x/phases/1-p/stories/01-search.md",
  storiesDir: "/repo/.harness/initiatives/x/phases/1-p/stories",
  phaseLabel: "Phase 1",
  phaseTitle: "Search",
  architectureFile: null,
  initiativeTitle: "X",
  initiativeFile: "/repo/.harness/initiatives/x/initiative.md",
  branch: "feature/s1",
  base: "origin/main",
};

const state = (cycles: string) => `# S1 — Add search

## Status
implement-done

## Plan
Change src/search.ts and src/search.test.ts.

## Cycles
${cycles}

## Evidence
`;

test("reads the cycle checklist with numbers, names and ticks", () => {
  const cycles = readCycles(
    state("- [x] Cycle 1 — Parse query: test parse → add parser\n- [ ] Cycle 2 — Rank: test order → sort\nnot a cycle"),
  );
  assert.deepEqual(
    cycles.map(({ number, name, done }) => ({ number, name, done })),
    [
      { number: 1, name: "Parse query", done: true },
      { number: 2, name: "Rank", done: false },
    ],
  );
  assert.equal(cycles[1].line, "- [ ] Cycle 2 — Rank: test order → sort");
});

test("unnumbered checklist lines are numbered in order", () => {
  assert.deepEqual(
    readCycles(state("- [ ] First thing\n- [ ] Second thing")).map((c) => [c.number, c.name]),
    [
      [1, "First thing"],
      [2, "Second thing"],
    ],
  );
});

test("a ticked cycle moves on to the next unticked one", () => {
  const after = afterImplement(state("- [x] Cycle 1 — A: a\n- [ ] Cycle 2 — B: b"), 1);
  assert.equal(after.kind, "cycle");
  assert.equal(after.kind === "cycle" && after.cycle.number, 2);
});

test("the last ticked cycle moves on to review", () => {
  assert.deepEqual(afterImplement(state("- [x] Cycle 1 — A: a\n- [x] Cycle 2 — B: b"), 2), { kind: "review" });
});

test("a cycle that ends without its tick blocks instead of starting it again", () => {
  const after = afterImplement(state("- [ ] Cycle 1 — A: a"), 1);
  assert.equal(after.kind, "blocked");
});

test("a whole-story or fix agent goes on to any unticked cycle, else review", () => {
  assert.equal(afterImplement(state("- [x] Cycle 1 — A: a\n- [ ] Cycle 2 — B: b"), null).kind, "cycle");
  assert.deepEqual(afterImplement(state(""), null), { kind: "review" });
});

test("commit messages name the cycle, the fix round or the whole change", () => {
  const cycle = readCycles(state("- [x] Cycle 3 — Rank: x"))[0];
  assert.equal(implementCommitMessage("S1", cycle, 1), "S1: Cycle 3 — Rank");
  assert.equal(implementCommitMessage("S1", null, 2), "S1: Fix review findings");
  assert.equal(implementCommitMessage("S1", null, 1), "S1: Implement");
});

test("a cycle prompt carries only that cycle and the plan", () => {
  const text = state("- [x] Cycle 1 — A: a\n- [ ] Cycle 2 — B: b");
  const cycle = readCycles(text)[1];
  const prompt = stepPrompt("implement", story, { round: 1, cycle, plan: readSection(text, "Plan") });
  assert.match(prompt, /Cycle 2 only/);
  assert.match(prompt, /- \[ \] Cycle 2 — B: b/);
  assert.match(prompt, /Change src\/search\.ts/);
  assert.doesNotMatch(prompt, /Cycle 1 — A/);
});

test("a cycle left after a review round still gets its cycle prompt, not the findings prompt", () => {
  const cycle = readCycles(state("- [ ] Cycle 4 — Rank: x"))[0];
  const prompt = stepPrompt("implement", story, { round: 2, cycle });
  assert.match(prompt, /Cycle 4 only/);
  assert.doesNotMatch(prompt, /fix the review findings/);
  assert.match(stepPrompt("implement", story, { round: 2 }), /fix the review findings/);
});

test("no step prompt names a skillsync command or tells the agent to commit or push", () => {
  for (const step of LOOP_STEPS.filter((s) => s !== "pr")) {
    for (const round of [1, 2]) {
      const prompt = stepPrompt(step, story, { round });
      assert.doesNotMatch(prompt, /\/ss-|skillsync/, `${step} r${round}`);
      assert.doesNotMatch(prompt, /git commit|git push/, `${step} r${round}`);
    }
  }
});

test("every step prompt sends tests, lint and build through the brief wrapper, not tail", () => {
  for (const step of LOOP_STEPS.filter((s) => s !== "pr")) {
    const prompt = stepPrompt(step, story, { round: 1 });
    assert.match(prompt, /run tests, lint and build through `\.harness\/bin\/brief`/, step);
    assert.doesNotMatch(prompt, /tail -n 60/, step);
  }
});

test("Jira stories point at the ticket and file follow-ups as review findings", () => {
  const jira: StoryContext = {
    ...story,
    id: "KEY-1",
    body: "",
    ticketUrl: "https://example.atlassian.net/browse/KEY-1",
    storyFile: null,
    storiesDir: null,
    phaseLabel: null,
    initiativeFile: null,
  };
  const prompt = stepPrompt("plan", jira, { round: 1, skills: ["react-review"] });
  assert.match(prompt, /Jira: https:\/\/example\.atlassian\.net\/browse\/KEY-1/);
  assert.match(prompt, /follow-up:/);
  assert.match(prompt, /Also use these skills: react-review\./);
  assert.doesNotMatch(prompt, /Initiative "/);
});

test("markers round-trip through ## Status with a detail line", () => {
  const written = writeMarker(state(""), "pr-done\nhttps://github.com/o/r/pull/1");
  assert.deepEqual(readMarker(written), { marker: "pr-done", detail: "https://github.com/o/r/pull/1" });
  assert.match(written, /## Plan\nChange src/);
});
