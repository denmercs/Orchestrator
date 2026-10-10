import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOOP_STEPS,
  MARKERS,
  afterImplement,
  commitSubject,
  formatSkills,
  readCycles,
  parseSkills,
  readMarker,
  readSection,
  stepPrompt,
  writeMarker,
  type Cycle,
  type LoopStep,
  type StepExtra,
  type StoryContext,
} from "./story-method";

const story: StoryContext = {
  id: "S1",
  title: "Add search",
  body: "Users can search.",
  ticketKey: null,
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

test("a parent that ran every cycle moves on to review, else blocks on the first unticked one", () => {
  assert.deepEqual(afterImplement(state("- [x] Cycle 1 — A: a\n- [x] Cycle 2 — B: b"), "all"), { kind: "review" });
  const after = afterImplement(state("- [x] Cycle 1 — A: a\n- [ ] Cycle 2 — B: b\n- [ ] Cycle 3 — C: c"), "all");
  assert.equal(after.kind, "blocked");
  assert.match(after.kind === "blocked" ? after.reason : "", /Cycle 2/);
});

test("the commit subject is the cleaned line after the marker, else the fallback", () => {
  const status = (body: string) => `# S1 — Demo\n\n## Status\n${body}\n\n## Cycles\n- [x] Cycle 1 — A: a\n`;
  assert.equal(commitSubject(status("implement-done\nLet Claude open PRs in this repo"), "A"), "Let Claude open PRs in this repo");
  assert.equal(commitSubject(status("implement-done\nS17: Add search\nmore detail"), "A"), "Add search");
  assert.equal(commitSubject(status("fix-done\nDCD-12 | Fix the lint error"), "A"), "Fix the lint error");
  assert.equal(commitSubject(status("implement-done"), "Rank"), "Rank");
  assert.equal(commitSubject(status("implement-done\nS17:"), "Rank"), "Rank");
  assert.equal(commitSubject("no status here", "Fix review findings"), "Fix review findings");
});

test("implement and fix prompts ask for a plain commit subject after the marker", () => {
  const text = state("- [x] Cycle 1 — A: a\n- [ ] Cycle 2 — B: b");
  const cycles = readCycles(text);
  const prompts = [
    stepPrompt("implement", story, { round: 1, cycle: cycles[1] }),
    stepPrompt("implement", story, { round: 1, cycles }),
    stepPrompt("implement", story, { round: 1 }),
    stepPrompt("implement", story, { round: 2 }),
  ];
  for (const prompt of prompts) {
    assert.match(prompt, /`implement-done` and put the commit subject on the next line/);
    assert.match(prompt, /imperative mood/);
    assert.match(prompt, /under 72 characters, with no story id, no "Cycle N" and no `feat:` prefix/);
  }
  const fix = stepPrompt("fix", story, { round: 1, failing: "- lint: broken" });
  assert.match(fix, /`fix-done` with one line on what you changed/);
  assert.match(fix, /That line is the commit subject/);
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

test("a parent prompt runs the unticked cycles in subagents, with the brief and the fallback", () => {
  const text = state("- [x] Cycle 1 — A: a\n- [ ] Cycle 2 — B: b\n- [ ] Cycle 3 — C: c");
  const prompt = stepPrompt("implement", story, { round: 1, cycles: readCycles(text), plan: readSection(text, "Plan") });
  const head = prompt.indexOf("for story S1");
  const step = prompt.slice(0, head);
  assert.match(step, /## This step: run the cycles in subagents/);
  assert.match(step, /## Cycle brief/);
  assert.match(step, /If you can't start subagents, work the cycles yourself, one at a time, in the same order/);
  assert.match(step, /tick its line in `## Cycles`/);
  assert.match(step, /set `## Status` to `implement-done`/);
  const brief = step.slice(step.indexOf("\n## Cycle brief\n"));
  assert.match(brief, /Do not touch `## Status`/);
  assert.match(brief, /may hold a half-finished cycle/);
  assert.ok(prompt.indexOf("\n## Cycles to run\n- [ ] Cycle 2 — B: b\n- [ ] Cycle 3 — C: c\n") > head, "cycles after the head");
  assert.ok(prompt.indexOf("Change src/search.ts") > head, "plan after the head");
  assert.doesNotMatch(prompt, /Cycle 1 — A/);
  assert.doesNotMatch(prompt, /one implement cycle/);
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

test("two stories share a step prompt up to the story head", () => {
  const other: StoryContext = {
    ...story,
    id: "S42",
    title: "Export reports",
    body: "Admins can export reports as CSV.",
    storyFile: "/repo/.harness/initiatives/y/phases/3-q/stories/07-export.md",
    storiesDir: "/repo/.harness/initiatives/y/phases/3-q/stories",
    phaseLabel: "Phase 3",
    phaseTitle: "Reporting",
    branch: "feature/s42-export",
    base: "origin/release-7",
  };
  // Story-specific step data: each story gets its own cycle, plan and failing checks.
  const data = new Map<StoryContext, { cycle: Cycle; cycles: Cycle[]; plan: string; failing: string }>([
    [
      story,
      {
        cycle: readCycles(state("- [ ] Cycle 2 — Rank: test order → sort"))[0],
        cycles: readCycles(state("- [ ] Cycle 1 — Parse: test parse → parser\n- [ ] Cycle 2 — Rank: test order → sort")),
        plan: "Change src/search.ts and src/search.test.ts.",
        failing: "- lint: src/search.ts unused import",
      },
    ],
    [
      other,
      {
        cycle: readCycles(state("- [ ] Cycle 5 — CSV: test columns → write csv"))[0],
        cycles: readCycles(state("- [ ] Cycle 4 — Header: test header → write header\n- [ ] Cycle 5 — CSV: test columns → write csv")),
        plan: "Change src/export.ts.",
        failing: "- unit: export.test.ts columns out of order",
      },
    ],
  ]);
  type Extra = (s: StoryContext, round: number) => StepExtra;
  const plain: Extra = (_s, round) => ({ round });
  const cases: [string, LoopStep, RegExp, Extra][] = [
    ["plan", "plan", /## This step: plan/, plain],
    ["review", "review", /## This step: review/, plain],
    ["pr", "pr", /## This step: open the pull request/, plain],
    ["implement", "implement", /## This step: (implement the story|fix the review findings)/, plain],
    [
      "implement cycle",
      "implement",
      /## This step: one implement cycle/,
      (s, round) => ({ round, cycle: data.get(s)!.cycle, plan: data.get(s)!.plan }),
    ],
    [
      "implement parent",
      "implement",
      /## This step: run the cycles in subagents/,
      (s) => ({ round: 1, cycles: data.get(s)!.cycles, plan: data.get(s)!.plan }),
    ],
    ["fix", "fix", /## This step: fix the failing CI checks/, (s, round) => ({ round, failing: data.get(s)!.failing })],
  ];
  const prefix = (step: LoopStep, s: StoryContext, extra: StepExtra) => {
    const prompt = stepPrompt(step, s, extra);
    const at = prompt.indexOf(`for story ${s.id}`);
    assert.ok(at > 0, `head missing for ${step} ${s.id} r${extra.round}`);
    return prompt.slice(0, prompt.lastIndexOf("\n", at) + 1);
  };
  for (const [name, step, heading, extra] of cases) {
    for (const round of [1, 2]) {
      const a = prefix(step, story, extra(story, round));
      assert.match(a, /## Rules for every step/, `${name} r${round} prefix`);
      assert.match(a, heading, `${name} r${round} prefix`);
      assert.equal(a, prefix(step, other, extra(other, round)), `${name} r${round}`);
      for (const s of [story, other]) {
        const { cycle, cycles, plan, failing } = data.get(s)!;
        const lines = cycles.map((c) => c.line);
        const values = [s.id, s.title, s.body, s.branch, s.base, s.storiesDir!, s.phaseTitle!, cycle.line, ...lines, plan, failing];
        for (const value of values) {
          assert.ok(!prefix(step, s, extra(s, round)).includes(value), `${name} r${round} prefix holds ${value}`);
        }
      }
    }
  }
});

test("a cycle's line and plan, and fix's failing checks, come after the head", () => {
  const cycle = readCycles(state("- [ ] Cycle 2 — B: b"))[0];
  const implement = stepPrompt("implement", story, { round: 1, cycle, plan: "Change src/search.ts." });
  const head = implement.indexOf("for story S1");
  assert.ok(implement.indexOf("\n## Cycle 2 only\n- [ ] Cycle 2 — B: b\n") > head, "cycle after the head");
  assert.ok(implement.indexOf("Change src/search.ts.") > head, "plan after the head");
  const fix = stepPrompt("fix", story, { round: 1, failing: "- lint: broken" });
  assert.ok(fix.indexOf("\n## Failing checks\n") > fix.indexOf("for story S1"), "failing checks after the head");
  assert.ok(fix.indexOf("- lint: broken") > fix.indexOf("\n## Failing checks\n"), "failing list under its heading");
});

test("review points at the base under Where it sits; pr carries the exact commands after the head", () => {
  const review = stepPrompt("review", story, { round: 1 });
  assert.match(review, /diff against the base branch named under `## Where it sits`/);
  assert.match(review, /cut from origin\/main/);
  const pr = stepPrompt("pr", story, { round: 1 });
  const head = pr.indexOf("for story S1");
  const commands = pr.indexOf("\n## PR commands\n");
  assert.ok(commands > head, "PR commands come after the head");
  assert.ok(pr.includes("git push -u origin feature/s1"), "push line");
  assert.ok(
    pr.includes('gh pr create --base main --head feature/s1 --title "Add search" --body-file .harness/pr-body.md'),
    "gh pr create line",
  );
  const jira = stepPrompt("pr", { ...story, id: "KEY-1", body: "", ticketUrl: "https://example.atlassian.net/browse/KEY-1" }, { round: 1 });
  assert.ok(jira.includes('--title "KEY-1 | Add search"'), "Jira PR title");
});

test("missing Plan paths go in the story section, after the head and before Where it sits", () => {
  const line = "These paths in ## Plan don't exist: src/a.ts, src/b.ts. Find the right ones and correct ## Plan.";
  const review = stepPrompt("review", story, { round: 1, missing: ["src/a.ts", "src/b.ts"] });
  const at = review.indexOf(`\n${line}\n`);
  assert.ok(at > review.indexOf("for story S1"), "missing line after the head");
  assert.ok(at > review.indexOf("\n## Story S1 — Add search\n"), "missing line in the story section");
  assert.ok(at < review.indexOf("\n## Where it sits\n"), "missing line before Where it sits");
  for (const missing of [undefined, []]) {
    const prompt = stepPrompt("review", story, { round: 1, missing });
    assert.ok(!prompt.includes("don't exist"), "no line when nothing is missing");
    assert.equal(prompt, stepPrompt("review", story, { round: 1 }));
  }
});

test("the Plan step asks for the brief lines, and the rules start every step from them", () => {
  const plan = stepPrompt("plan", story, { round: 1 });
  for (const label of ["**Files:**", "**Calls:**", "**Commands:**", "**Out of scope:**"]) {
    assert.ok(plan.includes(label), `Plan prompt asks for ${label}`);
  }
  assert.match(plan, /`\(new\)`/, "Files marks new paths");
  for (const step of LOOP_STEPS) {
    const prompt = stepPrompt(step, story, { round: 1 });
    assert.match(prompt, /open the files in `## Plan` first/, `${step}: open the Plan files first`);
    assert.match(prompt, /search further only when they turn out wrong or incomplete/, `${step}: search only when needed`);
    assert.match(prompt, /correct `## Plan`/, `${step}: correct the Plan`);
  }
});

test("the Diagnose step reproduces the bug, plans the fix and hands off without waiting for approval", () => {
  const bug = { ...story, ticketKey: "BUG-7", ticketUrl: "https://x.atlassian.net/browse/BUG-7" };
  const prompt = stepPrompt("diagnose", bug, { round: 1 });
  assert.match(prompt, /## This step: diagnose/);
  assert.match(prompt, /[Rr]eproduce/);
  assert.match(prompt, /find the cause/);
  assert.match(prompt, /`## Plan`/);
  assert.match(prompt, /`## Cycles`/);
  assert.match(prompt, /first cycle is a failing regression test/);
  assert.match(prompt, /set `## Status` to `diagnose-done` without waiting for approval/);
  assert.match(prompt, /`diagnose-blocked`/);
  assert.match(prompt, /BUG-7/);
  assert.ok(prompt.includes("https://x.atlassian.net/browse/BUG-7"), "names the ticket url");
  assert.equal(MARKERS.diagnoseDone, "diagnose-done");
  assert.equal(MARKERS.diagnoseBlocked, "diagnose-blocked");
});

test("Jira stories point at the ticket and file follow-ups as review findings", () => {
  const jira: StoryContext = {
    ...story,
    id: "KEY-1",
    body: "",
    ticketKey: "KEY-1",
    ticketUrl: "https://example.atlassian.net/browse/KEY-1",
    storyFile: null,
    storiesDir: null,
    phaseLabel: null,
    initiativeFile: null,
  };
  const prompt = stepPrompt("plan", jira, { round: 1, skills: [{ name: "react-review" }] });
  assert.match(prompt, /Jira: https:\/\/example\.atlassian\.net\/browse\/KEY-1/);
  assert.match(prompt, /follow-up:/);
  assert.match(prompt, /Also use these skills: react-review\./);
  assert.doesNotMatch(prompt, /Initiative "/);
});

test("an empty skills list leaves every step prompt exactly as it is without skills", () => {
  for (const step of LOOP_STEPS) {
    for (const round of [1, 2]) {
      assert.equal(stepPrompt(step, story, { round, skills: [] }), stepPrompt(step, story, { round }), `${step} r${round}`);
    }
  }
});

test("skills are named on the line under the step head, with no slash commands", () => {
  for (const step of LOOP_STEPS) {
    const prompt = stepPrompt(step, story, { round: 1, skills: [{ name: "a" }, { name: "b" }] });
    const lines = prompt.split("\n");
    const at = lines.findIndex((line) => line.endsWith(`for story ${story.id} — ${story.title}.`));
    assert.ok(at >= 0, `head missing for ${step}`);
    assert.equal(lines[at + 1], "Also use these skills: a, b.", step);
    assert.doesNotMatch(prompt, /\/ss-|(^|\s)\/[a-z][\w-]*(\s|$)/m, step);
  }
});

test("markers round-trip through ## Status with a detail line", () => {
  const written = writeMarker(state(""), "pr-done\nhttps://github.com/o/r/pull/1");
  assert.deepEqual(readMarker(written), { marker: "pr-done", detail: "https://github.com/o/r/pull/1" });
  assert.match(written, /## Plan\nChange src/);
});

test("each skill with a copied path is named with that path, and one without is named alone", () => {
  const skills = [{ name: "tdd", path: ".agents/skills/tdd/SKILL.md" }, { name: "ss-security-audit" }];
  const prompt = stepPrompt("implement", story, { round: 1, skills });
  assert.match(prompt, /^Also use these skills: tdd \(\.agents\/skills\/tdd\/SKILL\.md\), ss-security-audit\.$/m);
});

test("parseSkills reads back what formatSkills wrote", () => {
  const skills = [
    { name: "tdd", path: ".agents/skills/tdd/SKILL.md" },
    { name: "ss-security-audit" },
    { name: "review", path: ".claude/commands/review.md" },
  ];
  assert.equal(formatSkills(skills), "tdd (.agents/skills/tdd/SKILL.md), ss-security-audit, review (.claude/commands/review.md)");
  assert.deepEqual(parseSkills(formatSkills(skills)), skills);
  assert.deepEqual(parseSkills(""), []);
});

test("a memory brief adds a Memory brief block to the review step data and nothing else changes without it", () => {
  const plain = stepPrompt("review", story, { round: 1 });
  assert.equal(stepPrompt("review", story, { round: 1, brief: undefined }), plain);
  assert.doesNotMatch(plain, /## Memory brief/);
  const withBrief = stepPrompt("review", story, { round: 1, brief: ["area a: x/**", "A fact."] });
  assert.match(withBrief, /\n## Memory brief\n- area a: x\/\*\*\n- A fact\.\n/);
  assert.ok(withBrief.indexOf("## Memory brief") > withBrief.indexOf("Review for story S1"), "after the head");
});
