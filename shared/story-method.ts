// How one story is delivered, for both the initiative loop (server/initiative-loop.ts) and the
// Story pipeline (server/pipeline-advance.ts). Each step runs in a fresh agent in the story's worktree and
// gets its prompt from here; the server decides which step runs next from the marker the step
// writes. The prompts name no skills or slash commands, so they work the same for every provider
// (Claude, Cursor, Kiro). Edit here to change how every story is delivered.
//
// Implement runs one fresh agent per cycle, so no agent carries a whole story's context; or, given the
// story's unticked `cycles`, one parent agent that runs each cycle in a subagent (or itself, one at a time,
// where the provider has no subagents). Committing, pushing and opening the PR are done by the plugin,
// not by an agent.

import { LOOP_STEPS, STEP_LABELS, type LoopStep } from "./initiative-loop";
import { cleanSubject, prTitle } from "./naming";

export { LOOP_STEPS, STEP_LABELS, type LoopStep };

// The marker each step writes as the first line under `## Status` in .harness/state.md.
export const MARKERS = {
  planDone: "plan-done",
  diagnoseDone: "diagnose-done",
  diagnoseBlocked: "diagnose-blocked",
  implementDone: "implement-done",
  implementBlocked: "implement-blocked",
  reviewDone: "review-done",
  reviewFailed: "review-failed",
  prDone: "pr-done",
  fixDone: "fix-done",
} as const;

export type StoryContext = {
  id: string;
  title: string;
  // Story file text for initiative stories; empty for Jira tickets, which the agent reads itself.
  body: string;
  // The Jira key and link: a Jira ticket's own, or the bug a Diagnose story fixes.
  ticketKey: string | null;
  ticketUrl: string | null;
  // Initiative stories only.
  storyFile: string | null;
  storiesDir: string | null;
  phaseLabel: string | null;
  phaseTitle: string | null;
  architectureFile: string | null;
  initiativeTitle: string | null;
  initiativeFile: string | null;
  branch: string;
  // Remote-tracking base, e.g. origin/main.
  base: string;
};

export type Cycle = { number: number; name: string; line: string; done: boolean };

export type StepExtra = {
  round: number;
  failing?: string;
  // Implement: the one cycle this agent works, and the plan it works from.
  cycle?: Cycle;
  plan?: string;
  // Implement parent: the cycles it runs in subagents. Only unticked ones are listed.
  cycles?: Cycle[];
  // Extra skills the user picked for this step, named in the prompt with the path they were copied to.
  skills?: StepSkill[];
  // Existing-path entries in `## Plan` that aren't in the worktree.
  missing?: string[];
  // Review: memory brief lines, shown as `## Memory brief`. Absent or empty leaves the prompt unchanged.
  brief?: string[];
};

export type StepSkill = { name: string; path?: string };

// The text after "Also use these skills: ". Skill names never hold ", " or " (", so parseSkills can split it.
export function formatSkills(skills: StepSkill[]) {
  return skills.map((skill) => (skill.path ? `${skill.name} (${skill.path})` : skill.name)).join(", ");
}

export function parseSkills(text: string): StepSkill[] {
  return text
    .split(", ")
    .filter(Boolean)
    .map((part) => {
      const match = /^(.+?) \((.+)\)$/.exec(part);
      return match ? { name: match[1], path: match[2] } : { name: part };
    });
}

const STATE = ".harness/state.md";
// The plan is pasted into each cycle prompt so the agent starts from it instead of re-exploring.
const PLAN_LINES = 60;

// How an Implement agent hands the plugin its commit subject: the line after the marker.
const DONE = `\`${MARKERS.implementDone}\` and put the commit subject on the next line: one line in plain words,
imperative mood (e.g. "Let Claude commit, push and open PRs in this repo"),
under 72 characters, with no story id, no "Cycle N" and no \`feat:\` prefix`;

// The story's working file in its worktree. The plugin seeds it; every step reads and updates it.
export function seedState(story: StoryContext) {
  return `# ${story.id} — ${story.title}

## Status
starting

## Plan

## Open decisions

## Cycles

## Evidence

## Review findings

## Preview
`;
}

function context(story: StoryContext, missing: string[] = []) {
  const where = [
    story.initiativeFile ? `- Initiative "${story.initiativeTitle ?? ""}": ${story.initiativeFile}` : "",
    story.phaseLabel
      ? `- ${story.phaseLabel} — ${story.phaseTitle ?? ""}${story.architectureFile ? `: plan in ${story.architectureFile}` : ""}`
      : "",
    story.storiesDir ? `- Stories folder: ${story.storiesDir}` : "",
    `- Branch ${story.branch || "(this worktree's branch)"}, cut from ${story.base}. This worktree is the story's only checkout.`,
  ].filter(Boolean);
  return [
    `## Story ${story.id} — ${story.title}`,
    story.storyFile ? `Story file: ${story.storyFile}` : "",
    story.ticketUrl ? `Jira: ${story.ticketUrl}` : "",
    "",
    story.body.trim() ||
      (story.ticketUrl ? "_(Read the ticket with the Jira tools when your step needs it.)_" : "_(no body)_"),
    "",
    missing.length
      ? `These paths in ## Plan don't exist: ${missing.join(", ")}. Find the right ones and correct ## Plan.`
      : "",
    "",
    "## Where it sits",
    ...where,
  ]
    .filter((line, i, all) => line !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n");
}

function followUps(story: StoryContext) {
  if (!story.storiesDir) {
    return `- Work found outside this story (a bug elsewhere, missing groundwork, a follow-up) is not done here.
  Note it under \`## Review findings\` as "follow-up: <what and why>".`;
  }
  return `- Work found outside this story (a bug elsewhere, missing groundwork, a follow-up) is not done here. File it as a
  new story file in the stories folder named under \`## Where it sits\`, named NN-<slug>.md (NN after the highest
  existing number) with frontmatter \`id\` (next free id in the same style), \`title\`, \`status: todo\`,
  \`depends_on\` (only stories that must merge first) and \`discovered_from\` set to this story's id, and a short
  body saying what and why. At most three per story; after that, note it under \`## Review findings\` instead.`;
}

const FRESH = "You are a fresh agent for this step only, inside the Orchestrator story loop.";

const RULES = (story: StoryContext) => `## Rules for every step
- Work only in this worktree, on this story. Read AGENTS.md, CLAUDE.md, .cursor/rules, .kiro/steering and
  CONTRIBUTING.md when they exist, and follow the repo's own scripts for tests, lint and build.
- ${STATE} is this story's working file. Keep its section headings; update only the sections your step owns.
- Keep context small: open the files in \`## Plan\` first,
  search further only when they turn out wrong or incomplete, and when they do, correct \`## Plan\`.
  Run the narrowest test command that covers your work,
  and run tests, lint and build through \`.harness/bin/brief\` (for example \`.harness/bin/brief npm test\`).
  Its output is failures plus a summary; the full log is in \`.harness/logs/\`.
- End the step by replacing everything under \`## Status\` with your marker on its own line. The plugin reads
  that line when your turn ends and starts the next step in a fresh agent. Do not start the next step yourself.
- Do not commit, push or merge. The plugin commits each finished step and opens the PR.
${followUps(story)}
- If the human messages you, answer and follow their direction, then finish this step.`;

// A Jira ticket has a ticket URL and no story file text of its own.
const isJira = (story: StoryContext) => Boolean(story.ticketUrl) && !story.body.trim();

export function stepPrompt(step: LoopStep, story: StoryContext, extra: StepExtra) {
  const label = extra.cycle ? `${STEP_LABELS[step]} cycle ${extra.cycle.number}` : STEP_LABELS[step];
  const head = `${label} for story ${story.id} — ${story.title}${extra.round > 1 ? ` (round ${extra.round})` : ""}.`;
  const skills = extra.skills?.length ? `Also use these skills: ${formatSkills(extra.skills)}.` : "";
  const jira = isJira(story);
  // Text shared by every story at this step comes first, so the provider can cache it across agents.
  // STEPS get no story; story values go after the head, in STEP_DATA and context().
  const data = STEP_DATA[step]?.(story, extra) ?? "";
  return [FRESH, "", RULES(story), "", STEPS[step](extra, jira), "", head, skills, "", data, "", context(story, extra.missing)]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}

const IMPLEMENT_CYCLE = `## This step: one implement cycle
Work the one cycle under \`## Cycle N only\` below the story head, from the plan pasted there.
1. Write this cycle's test. Run it and confirm it fails for the reason you expect.
2. Make the smallest production change that passes it. Do not weaken the test.
3. Revert the production change, confirm the test fails again, restore it, confirm it passes.
4. Tick this cycle's line in \`## Cycles\` (\`- [x]\`) and add one line to \`## Evidence\`: the command and the
   fail → pass result.
Work only this cycle; a fresh agent takes the next one. Then set \`## Status\` to ${DONE}.
If you cannot go on (a missing decision, broken tooling, a dependency that isn't there), set it to
\`${MARKERS.implementBlocked}\` and put the reason on the next line.`;

const IMPLEMENT_PARENT = `## This step: run the cycles in subagents
The cycles to run are under \`## Cycles to run\` below the story head, in order, with the plan pasted there.
1. Work the cycles one at a time, in order, never in parallel. For each, start a subagent and give it the
   \`## Cycle brief\` below plus that cycle's line. Wait for its fail → pass report.
2. When it reports the cycle done, tick its line in \`## Cycles\` (\`- [x]\`) and move on to the next cycle.
3. If a subagent cannot go on, stop: set \`## Status\` to \`${MARKERS.implementBlocked}\` and put its reason on the
   next line.
If you can't start subagents, work the cycles yourself, one at a time, in the same order, following the brief.
When every cycle is ticked, set \`## Status\` to ${DONE}.

## Cycle brief
Work the one cycle you were given, from \`## Plan\` in ${STATE}. The worktree may hold a half-finished cycle
from an earlier agent; check what is already there before you start.
1. Write this cycle's test. Run it and confirm it fails for the reason you expect.
2. Make the smallest production change that passes it. Do not weaken the test.
3. Revert the production change, confirm the test fails again, restore it, confirm it passes.
4. Add one line to \`## Evidence\`: the command and the fail → pass result.
Do not touch \`## Status\` or tick \`## Cycles\`; the parent does both. Report fail → pass, or why you
cannot go on.`;

function planData(plan: string | undefined) {
  const planLines = (plan ?? "").trim().split("\n");
  const planText = planLines.slice(0, PLAN_LINES).join("\n") + (planLines.length > PLAN_LINES ? "\n…" : "");
  return `The plan, from \`## Plan\`:
${planText || "_(empty — read ## Plan in the state file)_"}`;
}

function cyclesData(cycles: Cycle[], plan: string | undefined) {
  return `## Cycles to run
${cycles
  .filter((cycle) => !cycle.done)
  .map((cycle) => cycle.line)
  .join("\n")}

${planData(plan)}`;
}

function cycleData(cycle: Cycle, plan: string | undefined) {
  return `## Cycle ${cycle.number} only
${cycle.line}

${planData(plan)}`;
}

const STEPS: Record<LoopStep, (extra: StepExtra, jira: boolean) => string> = {
  plan: (_extra, jira) => `## This step: plan the story, then wait for approval
1. Read the story${jira ? " (the Jira ticket and its acceptance criteria)" : ""}, its phase plan and the code it touches. Use real paths from this checkout.
2. Write \`## Plan\` in ${STATE}: the approach in a few lines, then these labelled lines, then how the story's
   acceptance will be checked. Later agents start from this section alone, so use real paths.
   - \`**Files:**\` the paths you expect to change, with \`(new)\` after each new one.
   - \`**Calls:**\` the functions or interfaces the change uses, each with its path.
   - \`**Commands:**\` the narrowest test command for this work, and the gate.
   - \`**Out of scope:**\` nearby work this story does not do.
3. Write \`## Open decisions\`: each real choice as "question → recommended answer → what changes either way".
   List small defaults you assumed as "assumption → answer" lines.
4. Write \`## Cycles\`: the work as test-first cycles, one checklist line each, in order:
   \`- [ ] Cycle N — <name>: <failing test to write> → <smallest change that passes it>\`.
   Include the command that runs each cycle's test. Each cycle runs in its own fresh agent, so keep each one
   small and self-contained.
5. Do not write production code or tests.
6. Summarise the plan and the open decisions for the human, then ask them to approve it. Answer questions and
   rewrite the plan as they push back.
7. Only when they explicitly approve, set \`## Status\` to \`${MARKERS.planDone}\`. Waiting for them is expected.`,

  diagnose: () => `## This step: diagnose the bug, then plan the fix
The bug's Jira ticket is under \`## Bug\` below the story head.
1. Read the ticket and the code it touches. Reproduce the bug: a failing test where you can, else exact steps.
2. Then find the cause. Note what you ruled out on the way.
3. Write \`## Plan\` in ${STATE}: the cause and the fix in a few lines, then the same labelled lines a plan has
   (\`**Files:**\`, \`**Calls:**\`, \`**Commands:**\`, \`**Out of scope:**\`), then how the fix will be checked.
4. Write \`## Cycles\` as test-first checklist lines,
   \`- [ ] Cycle N — <name>: <failing test to write> → <smallest change that passes it>\`, each with its command.
   The first cycle is a failing regression test that reproduces the bug.
5. Do not write production code or tests.
6. When both are written, set \`## Status\` to \`${MARKERS.diagnoseDone}\` without waiting for approval; Implement starts from your plan.
If you cannot reproduce the bug or find its cause, set it to \`${MARKERS.diagnoseBlocked}\` and put the reason on
the next line.`,

  implement: ({ round, cycle, cycles }) => {
    if (cycle) {
      return IMPLEMENT_CYCLE;
    }
    if (cycles?.length && round === 1) {
      return IMPLEMENT_PARENT;
    }
    if (round > 1) {
      return `## This step: fix the review findings
Review found problems. Fix every item under \`## Review findings\` (skip "follow-up:" lines), each with a test
that fails before the fix, and add one line per fix to \`## Evidence\`. Do not work unticked cycles; fresh agents
take those. Then set \`## Status\` to ${DONE}.
If you cannot go on, set it to \`${MARKERS.implementBlocked}\` and put the reason on the next line.`;
    }
    // No checklist in ## Cycles: one agent does the whole change.
    return `## This step: implement the story
\`## Cycles\` has no checklist, so work the change test-first from \`## Plan\`:
1. Write a test, run it and confirm it fails for the reason you expect.
2. Make the smallest production change that passes it. Do not weaken the test.
3. Add a line to \`## Evidence\`: the command and the fail → pass result. Repeat until the story is done.
Then set \`## Status\` to ${DONE}.
If you cannot go on, set it to \`${MARKERS.implementBlocked}\` and put the reason on the next line.`;
  },

  review: () => `## This step: review the change as a fresh critic
Review the diff against the base branch named under \`## Where it sits\` (\`git diff <base>...HEAD\`): check it
against the story, its acceptance, \`## Plan\` and \`## Cycles\`. Do not fix anything.
Check:
- Every acceptance check is met, and each cycle has a test that would fail without its change.
- Correctness: edge cases, error paths, concurrency, data loss.
- Security: input validation, injection, auth and permission checks, secrets in code or logs, unsafe shell or
  file paths, new dependencies.
- The repo's own conventions, and nothing changed outside the story's scope.
- The full test suite, lint and build pass (run them; keep only the summary and any failures).
Write each problem under \`## Review findings\` as one line: file:line — what is wrong — what would fix it.
Write \`## Preview\`: one line per app route or screen the story changes, "- <route> — what to look at", or
\`none — <why>\` when nothing is visible.
Write .harness/pr-body.md: a short Purpose, the Changes Made as bullets, and how it was tested.
If there are no findings that must be fixed, set \`## Status\` to \`${MARKERS.reviewDone}\`; otherwise set it to
\`${MARKERS.reviewFailed}\`. The plugin opens the PR after a pass.`,

  // Kept for stories that were already at this step; new stories get their PR from the plugin.
  pr: () => `## This step: open the pull request
1. Push the branch with the push command under \`## PR commands\`.
2. Open the PR with the \`gh pr create\` command under \`## PR commands\`.
   If a PR for the branch already exists, keep it.
3. Set \`## Status\` to \`${MARKERS.prDone}\` with the PR URL on the next line.
This step may push. Do not wait for CI and do not merge.`,

  fix: ({ round }) => `## This step: fix the failing CI checks (attempt ${round})
The checks that failed on the PR's latest commit are under \`## Failing checks\` below the story head.

1. Reproduce each failure locally with the repo's own command where you can.
2. Fix the cause, not the check. Do not skip, disable or weaken tests or lint rules.
3. Set \`## Status\` to \`${MARKERS.fixDone}\` with one line on what you changed.
   That line is the commit subject: plain words, imperative mood, under 72 characters, no story id. The plugin
   commits and pushes.
If the failure is not caused by this branch (flaky infrastructure, a broken base branch), change nothing and say so
on the line after \`${MARKERS.fixDone}\`.`,
};

// Story-specific data a step needs, placed after the head so it does not break the shared prefix.
const STEP_DATA: Partial<Record<LoopStep, (story: StoryContext, extra: StepExtra) => string>> = {
  diagnose: (story) => `## Bug
${[story.ticketKey, story.ticketUrl].filter(Boolean).join(" — ") || "(no ticket; the story body describes the bug)"}`,
  implement: (_story, { round, cycle, cycles, plan }) => {
    if (cycle) return cycleData(cycle, plan);
    return cycles?.length && round === 1 ? cyclesData(cycles, plan) : "";
  },
  review: (_story, { brief }) => (brief?.length ? `## Memory brief\n${brief.map((l) => `- ${l}`).join("\n")}` : ""),
  fix: (_story, { failing }) => `## Failing checks
${failing ?? "(see the PR's checks)"}`,
  pr: (story) => `## PR commands
- Push: \`git push -u origin ${story.branch}\`
- Open: \`gh pr create --base ${story.base.replace(/^origin\//, "")} --head ${story.branch} --title "${prTitle({ ...story, jira: isJira(story) }).replace(/"/g, "'")}" --body-file .harness/pr-body.md\``,
};

// The first non-empty line under `## Status`, and the lines after it (a reason or a URL).
export function readMarker(state: string) {
  const lines = readSection(state, "Status")
    .split("\n")
    .map((line) => line.trim().replace(/^`|`$/g, ""))
    .filter(Boolean);
  return { marker: lines[0]?.toLowerCase() ?? null, detail: lines.slice(1).join(" ") };
}

// Replaces the body of `## Status` with one line.
export function writeMarker(state: string, marker: string) {
  if (!/^##\s+Status\s*$/m.test(state)) return `${state.trimEnd()}\n\n## Status\n${marker}\n`;
  return state.replace(/^(##\s+Status\s*\n)([\s\S]*?)(?=^##\s|(?![\s\S]))/m, `$1${marker}\n\n`);
}

// The body of a `## <heading>` section, or "" when it is missing.
export function readSection(state: string, heading: string) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "m").exec(state);
  return match?.[1] ?? "";
}

// The checklist under `## Cycles`: `- [ ] Cycle N — <name>: …` lines, in order.
export function readCycles(state: string): Cycle[] {
  const cycles: Cycle[] = [];
  for (const raw of readSection(state, "Cycles").split("\n")) {
    const item = /^\s*[-*]\s*\[([ xX])\]\s*(.+)$/.exec(raw);
    if (!item) continue;
    const text = item[2].trim();
    const numbered = /^Cycle\s+(\d+)\s*[—–:-]?\s*(.*)$/i.exec(text);
    const rest = numbered ? numbered[2] : text;
    cycles.push({
      number: numbered ? Number(numbered[1]) : cycles.length + 1,
      name: (rest.split(":")[0] ?? rest).trim() || text,
      line: raw.trim(),
      done: item[1] !== " ",
    });
  }
  return cycles;
}

export type AfterImplement =
  | { kind: "cycle"; cycle: Cycle }
  | { kind: "review" }
  | { kind: "blocked"; reason: string };

// What follows an Implement agent that wrote implement-done. `finished` is the cycle it was given,
// "all" for a parent that ran every cycle in subagents, or null for a whole-story or fix-findings
// agent. A cycle that was not ticked stops the loop, so a confused agent can't make the plugin start
// the same cycle forever.
export function afterImplement(state: string, finished: number | "all" | null): AfterImplement {
  const cycles = readCycles(state);
  if (finished === "all") {
    const open = cycles.find((cycle) => !cycle.done);
    return open
      ? { kind: "blocked", reason: `Cycle ${open.number} was not ticked in ## Cycles when Implement finished.` }
      : { kind: "review" };
  }
  if (finished !== null) {
    const own = cycles.find((cycle) => cycle.number === finished);
    if (own && !own.done) {
      return { kind: "blocked", reason: `Cycle ${finished} ended without being ticked in ## Cycles.` };
    }
  }
  const next = cycles.find((cycle) => !cycle.done);
  return next ? { kind: "cycle", cycle: next } : { kind: "review" };
}

// The commit subject a finished step wrote on the line after its marker, cleaned; else `fallback`.
export function commitSubject(state: string, fallback: string) {
  const line = readSection(state, "Status")
    .split("\n")
    .map((text) => text.trim())
    .filter(Boolean)[1];
  return (line && cleanSubject(line)) ?? fallback;
}
