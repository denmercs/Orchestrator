import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentCreateConfig } from "../shared/agent-runner";
import { DEFAULT_PHASES, STEP_PHASES, pipelineSettings, stepSkills, type Phase, type SkillSource } from "../shared/pipeline";
import {
  STEP_LABELS,
  formatSkills,
  readSection,
  seedState,
  stepPrompt,
  writeMarker,
  type Cycle,
  type LoopStep,
  type StoryContext,
} from "../shared/story-method";
import { loadPhaseConfig, type RunnerProfiles } from "./agent-runner";
import { briefTag, installBrief } from "./brief-install";
import { writeFrontmatter } from "./harness-layout";
import { withMcpScope } from "./mcp-scope";
import { missingPaths, planPaths } from "./plan-paths";
import { repoPipelineConfig, repoReviewMode } from "./repo-pipeline";
import { installSkills, skillPaths } from "./skill-sources";
import { prepareTestingSkill } from "./testing-skill";

// Marks loop workspaces and sessions, like 📐 marks architecture sessions.
export const MARK = "🔁";

// Ends the prompt of a fresh session that replaces one that died mid-step.
export const RESTART_LINE = "Resume from `.harness/state.md`. An earlier session for this step stopped before it finished.";

export const STATUS_FOR: Record<LoopStep, string> = {
  plan: "planning",
  diagnose: "planning",
  implement: "implementing",
  review: "reviewing",
  pr: "reviewing",
  fix: "pr-open",
};

// The follow-up sent to a stalled step session.
export function nudgePrompt(why: string) {
  return `${why}\n\nCarry on with this step from \`.harness/state.md\`. When it is finished, write the step's marker under ## Status as your first prompt says.`;
}

// The stuck evidence a step carries in its frontmatter; a new step or a reopen starts it clean.
export const STUCK_CLEAR = {
  idle_turns: null,
  fail_tests: null,
  fail_runs: null,
  ceremony_turns: null,
  fail_edits: null,
  stuck_nudged: null,
  mid_turn: null,
  mid_fingerprint: null,
  mid_changed: null,
  mid_nudged: null,
  waiting_subagent_since: null,
};

const readText = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
const stateFile = (worktree: string) => join(worktree, ".harness", "state.md");

// The drawer's phases with the repo's `.orchestrator/pipeline.json` applied, as its stories run them.
export function repoPhases(phases: Phase[], worktree: string | null) {
  return repoPipelineConfig(pipelineSettings.schema.parse({ phases }), worktree).phases;
}

// The `## Plan` paths that Implement, Review or Fix CI can't find on disk. The Plan step writes them,
// so it isn't checked.
export function planMissing(step: LoopStep, state: string, worktree: string) {
  if (step !== "implement" && step !== "review" && step !== "fix") return [];
  return missingPaths(planPaths(readSection(state, "Plan")), worktree);
}

export type LaunchInput = {
  api: RunnerProfiles;
  storyFile: string;
  worktree: string;
  ctx: StoryContext;
  step: LoopStep;
  round: number;
  // What the agent is started with, and what the caller finds it by.
  labels: Record<string, string>;
  readPipeline: () => Promise<{ phases: Phase[]; sources: SkillSource[] }>;
  readAgentConfig: () => Promise<AgentCreateConfig>;
  // Starts the agent where the caller wants it (the loop's workspace, a slice's seat).
  create: (spec: { title: string; config: AgentCreateConfig; prompt: string; labels: Record<string, string> }) => Promise<{ id: string }>;
  failing?: string;
  cycle?: Cycle;
  cycles?: Cycle[];
  // A supervised restart of a step whose session died; it keeps the story's retry count.
  attempt?: number;
};

// Starts one story step in a worktree: marks it running, installs the brief and skills, builds the
// prompt, starts the agent and writes the step onto the story. Returns the agent's id.
export async function launchStep(input: LaunchInput): Promise<string> {
  const { api, storyFile, worktree, ctx, step, round, labels } = input;
  const state = readText(stateFile(worktree)) || seedState(ctx);
  writeFileSync(stateFile(worktree), writeMarker(state, `${step}-running`), "utf8");
  const base = input.cycle ? `${STEP_LABELS[step]} ${input.cycle.number}` : STEP_LABELS[step];
  const label = round > 1 ? `${base} r${round}` : base;
  // A missing wrapper costs the agent its short test output, not the step.
  await installBrief(worktree, briefTag(step, round, input.cycle?.number)).catch((error) =>
    console.warn("orchestrator: install brief", ctx.id, error),
  );
  // Skills help a step but never gate it: a failed read or copy becomes a warning on the story.
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const warnings: string[] = [];
  const piped = await input.readPipeline().catch((error) => {
    warnings.push(`pipeline: ${reason(error)}`);
    return { phases: DEFAULT_PHASES, sources: [] };
  });
  const { sources } = piped;
  const phases = repoPhases(piped.phases, worktree);
  // A repo can give each story phase its own model; the default tier (Opus for Plan and Review, Sonnet for Implement and Fix CI) applies when it doesn't.
  const phaseId = STEP_PHASES[step];
  const agentConfig = await loadPhaseConfig(api, phases.find((p) => p.id === phaseId)?.profile, await input.readAgentConfig());
  // A repo's light Review drops the full-diff review skills after round 1 (shared/pipeline.ts reviewRoundSkills).
  const reviewMode = step === "review" ? repoReviewMode(worktree) : "full";
  const extras = stepSkills(step, phases, { mode: reviewMode, round });
  warnings.push(...(await installSkills(worktree, extras, sources).catch((error) => [`skills: ${reason(error)}`])));
  for (const warning of warnings) console.warn("orchestrator: skills", ctx.id, warning);
  const skills = await skillPaths(worktree, extras, sources);
  // Implement and Review only: the testing guidelines (the repo's own, the built-in, or none).
  const testing = await prepareTestingSkill(worktree, step).catch((error) => ({
    path: undefined,
    warning: `testing skill: ${reason(error)}`,
  }));
  if (testing.warning) {
    warnings.push(testing.warning);
    console.warn("orchestrator: skills", ctx.id, testing.warning);
  }
  const prompt = stepPrompt(step, ctx, {
    round,
    failing: input.failing,
    cycle: input.cycle,
    cycles: input.cycles,
    plan: readSection(state, "Plan"),
    missing: planMissing(step, state, worktree),
    skills,
    testingSkill: testing.path,
    ...(reviewMode === "light" ? { light: true } : {}),
  });
  // Story steps work from the story file and the worktree; none of them needs an MCP server.
  const agent = await withMcpScope(worktree, "none", () =>
    input.create({
      title: `${MARK} ${ctx.id} · ${label} — ${ctx.title}`.slice(0, 60),
      config: agentConfig,
      prompt: input.attempt ? `${prompt}\n\n${RESTART_LINE}` : prompt,
      labels,
    }),
  );
  writeFrontmatter(storyFile, {
    status: STATUS_FOR[step],
    ...(step === "fix"
      ? {}
      : { step, round, cycle: input.cycle?.number ?? null, cycles: input.cycles ? "subagents" : null }),
    agent: agent.id,
    blocked_reason: null,
    blocked_from: null,
    blocked_at: null,
    limit_recovered: null,
    block_kind: null,
    stalled: null,
    paused_until: null,
    paused_for: null,
    waiting_on: null,
    ...(input.attempt ? {} : { retries: null }),
    ...STUCK_CLEAR,
    // A restart of an Implement round after a failed test run lists the same checks again.
    ...(step === "implement" ? { failing: input.failing ? JSON.stringify(input.failing) : null } : {}),
    skill_warnings: warnings.join(" · ") || null,
    // The first prompt's skills line, so a resumed agent gets the same one.
    step_skills: formatSkills(skills) || null,
  });
  return agent.id;
}
