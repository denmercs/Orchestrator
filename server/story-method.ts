// How the initiative loop delivers one story. Each step runs in a fresh agent in the story's
// worktree and gets its prompt from here; server/initiative-loop.ts decides which step runs next
// from the marker the step writes. The prompts name no skills or slash commands, so they work the
// same for every provider (Claude, Cursor, Kiro). Edit here to change how every story is delivered.

export const LOOP_STEPS = ["plan", "implement", "review", "pr", "fix"] as const;
export type LoopStep = (typeof LOOP_STEPS)[number];

export const STEP_LABELS: Record<LoopStep, string> = {
  plan: "Plan",
  implement: "Implement",
  review: "Review",
  pr: "Open PR",
  fix: "Fix CI",
};

// The marker each step writes as the first line under `## Status` in .harness/state.md.
export const MARKERS = {
  planDone: "plan-done",
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
  body: string;
  storyFile: string;
  storiesDir: string;
  phaseLabel: string;
  phaseTitle: string;
  architectureFile: string | null;
  initiativeTitle: string;
  initiativeFile: string;
  branch: string;
  // Remote-tracking base, e.g. origin/main.
  base: string;
};

const STATE = ".harness/state.md";

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

function context(story: StoryContext) {
  return [
    `## Story ${story.id} — ${story.title}`,
    `Story file: ${story.storyFile}`,
    "",
    story.body.trim() || "_(no body)_",
    "",
    "## Where it sits",
    `- Initiative "${story.initiativeTitle}": ${story.initiativeFile}`,
    `- ${story.phaseLabel} — ${story.phaseTitle}${story.architectureFile ? `: plan in ${story.architectureFile}` : ""}`,
    `- Branch ${story.branch}, cut from ${story.base}. This worktree is the story's only checkout.`,
  ].join("\n");
}

const RULES = (story: StoryContext) => `## Rules for every step
- Work only in this worktree, on this story. Read AGENTS.md, CLAUDE.md, .cursor/rules, .kiro/steering and
  CONTRIBUTING.md when they exist, and follow the repo's own scripts for tests, lint and build.
- ${STATE} is this story's working file. Keep its section headings; update only the sections your step owns.
- End the step by replacing everything under \`## Status\` with your marker on its own line. The plugin reads
  that line when your turn ends and starts the next step in a fresh agent. Do not start the next step yourself.
- Never push to ${story.base.replace(/^origin\//, "")}, never merge, never force-push. Only the Open PR and Fix CI steps push.
- Work found outside this story (a bug elsewhere, missing groundwork, a follow-up) is not done here. File it as a
  new story file in ${story.storiesDir}/ named NN-<slug>.md (NN after the highest existing number) with
  frontmatter \`id\` (next free id in the same style), \`title\`, \`status: todo\`, \`depends_on\` (only stories that
  must merge first) and \`discovered_from: ${story.id}\`, and a short body saying what and why. At most three per
  story; after that, note it under \`## Review findings\` instead.
- If the human messages you, answer and follow their direction, then finish this step.`;

export function stepPrompt(step: LoopStep, story: StoryContext, extra: { round: number; failing?: string }) {
  const head = `${STEP_LABELS[step]} for story ${story.id} — ${story.title}${extra.round > 1 ? ` (round ${extra.round})` : ""}.
You are a fresh agent for this step only, inside the Orchestrator initiative loop.`;
  return [head, "", STEPS[step](story, extra), "", RULES(story), "", context(story)].join("\n");
}

const STEPS: Record<LoopStep, (story: StoryContext, extra: { round: number; failing?: string }) => string> = {
  plan: () => `## This step: plan the story, then wait for approval
1. Read the story, its phase plan and the code it touches. Use real paths from this checkout.
2. Write \`## Plan\` in ${STATE}: the approach in a few lines, the files you expect to change, and how the
   story's acceptance will be checked.
3. Write \`## Open decisions\`: each real choice as "question → recommended answer → what changes either way".
   List small defaults you assumed as "assumption → answer" lines.
4. Write \`## Cycles\`: the work as test-first cycles, one checklist line each, in order:
   \`- [ ] Cycle N — <name>: <failing test to write> → <smallest change that passes it>\`.
   Include the command that runs each cycle's test.
5. Do not write production code or tests, and do not commit.
6. Summarise the plan and the open decisions for the human, then ask them to approve it. Answer questions and
   rewrite the plan as they push back.
7. Only when they explicitly approve, set \`## Status\` to \`${MARKERS.planDone}\`. Waiting for them is expected.`,

  implement: (_story, { round }) => `## This step: implement the cycles
${round > 1
    ? `Review found problems. Fix every item under \`## Review findings\` first, each with a test that fails before the fix, then finish any unticked cycles.`
    : "Work the unticked cycles in `## Cycles`, in order."}
For each cycle:
1. Write the cycle's test. Run it and confirm it fails for the reason you expect.
2. Make the smallest production change that passes it. Do not weaken the test.
3. Revert the production change, confirm the test fails again, restore it, confirm it passes.
4. Tick the cycle and add a line to \`## Evidence\`: the command and the fail → pass result.
5. Commit the cycle locally: \`git add\` the files you changed (never .harness/) and \`git commit -m "<story id>: <cycle name>"\`.
When every cycle is ticked, run the full test suite, lint and build the repo defines and record the results in
\`## Evidence\`. Then set \`## Status\` to \`${MARKERS.implementDone}\`.
If you cannot go on (a missing decision, broken tooling, a dependency that isn't there), set it to
\`${MARKERS.implementBlocked}\` and put the reason on the next line.`,

  review: (story) => `## This step: review the change as a fresh critic
Review \`git diff ${story.base}...HEAD\` against the story, its acceptance, \`## Plan\` and \`## Cycles\`. Do not fix anything.
Check:
- Every acceptance check is met, and each cycle has a test that would fail without its change.
- Correctness: edge cases, error paths, concurrency, data loss.
- Security: input validation, injection, auth and permission checks, secrets in code or logs, unsafe shell or
  file paths, new dependencies.
- The repo's own conventions, and nothing changed outside the story's scope.
- The full test suite, lint and build pass (run them).
Write each problem under \`## Review findings\` as one line: file:line — what is wrong — what would fix it.
Write \`## Preview\`: one line per app route or screen the story changes, "- <route> — what to look at", or
\`none — <why>\` when nothing is visible.
Write .harness/pr-body.md: a short Purpose, the Changes Made as bullets, and how it was tested.
If there are no findings that must be fixed, set \`## Status\` to \`${MARKERS.reviewDone}\`; otherwise set it to
\`${MARKERS.reviewFailed}\`.`,

  pr: (story) => `## This step: open the pull request
1. Make sure the work tree is clean apart from .harness/ (commit anything left with \`<story id>: <what>\`).
2. Push the branch: \`git push -u origin ${story.branch}\`.
3. Open the PR: \`gh pr create --base ${story.base.replace(/^origin\//, "")} --head ${story.branch} --title "${story.id}: ${story.title.replace(/"/g, "'")}" --body-file .harness/pr-body.md\`.
   If a PR for the branch already exists, keep it.
4. Set \`## Status\` to \`${MARKERS.prDone}\` with the PR URL on the next line.
Do not wait for CI and do not merge. The plugin watches CI and starts a Fix CI agent if a check fails; the human merges.`,

  fix: (_story, { round, failing }) => `## This step: fix the failing CI checks (attempt ${round})
These checks failed on the PR's latest commit:

${failing ?? "(see the PR's checks)"}

1. Reproduce each failure locally with the repo's own command where you can.
2. Fix the cause, not the check. Do not skip, disable or weaken tests or lint rules.
3. Commit (\`<story id>: Fix CI — <what>\`) and push the branch. Do not force-push.
4. Set \`## Status\` to \`${MARKERS.fixDone}\` with one line on what you changed.
If the failure is not caused by this branch (flaky infrastructure, a broken base branch), change nothing and say so
on the line after \`${MARKERS.fixDone}\`.`,
};

// The first non-empty line under `## Status`, and the lines after it (a reason or a URL).
export function readMarker(state: string) {
  const match = /^##\s+Status\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(state);
  const lines = (match?.[1] ?? "")
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
