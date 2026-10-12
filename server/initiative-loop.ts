import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { PluginHandlerContext, PluginHookAgent, PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { AgentCreateConfig } from "../shared/agent-runner";
import { LOOP_AGENT_KIND, type LoopConfig } from "../shared/initiative-loop";
import { branchName } from "../shared/naming";
import { phaseLabel } from "../shared/orchestration";
import { budgetMoney } from "../shared/stats-strip";
import { storyCost, type TelemetryRow } from "./context-telemetry";
import { DEFAULT_PHASES, stepSkills, type Phase, type SkillSource } from "../shared/pipeline";
import type { ToolItem } from "../shared/exploration";
import { midTurnCheck, stuckCheck, toolRunningSince, type StuckCounters, type TimelineEntry } from "../shared/stuck";
import { appendOutcome, type OutcomeEvent } from "../shared/story-outcome";
import {
  PHASES_DIR,
  PHASE_FILE,
  dirsIn,
  excludeHarness,
  frontmatter,
  initiativeLoopState,
  initiativeTitle,
  initiativesDir,
  readStoryFiles,
  refreshInitiativeIndex,
  writeFrontmatter,
  slugOf,
} from "./harness-layout";
import { briefTag, installBrief } from "./brief-install";
import { ciAction } from "./ci-watch";
import { failureReport, prForBranch, prStatus } from "./pr-checks";
import { missingPaths, planPaths } from "./plan-paths";
import {
  MARKERS,
  STEP_LABELS,
  afterImplement,
  afterReview,
  commitSubject,
  formatSkills,
  parseSkills,
  readCycles,
  readMarker,
  readSection,
  seedState,
  stepPrompt,
  writeMarker,
  type Cycle,
  type LoopStep,
  type StoryContext,
} from "../shared/story-method";
import { withMcpScope } from "./mcp-scope";
import { installSkills, skillPaths } from "./skill-sources";
import { commitStory, failureText, openStoryPr, pushStoryFix, uniqueBranch } from "./story-git";
import { activeBriefRuns, briefRuns, worktreeFingerprint } from "./turn-progress";
import { clockTime, providerName } from "../shared/plan-usage";
import { readPlanUsage } from "./plan-usage";
import { inHoldWindow, limitNotice, planLimitUntil, usageLimitResumeAt } from "./usage-limit";

// The stuck evidence a step carries in its frontmatter; a new step or a reopen starts it clean.
const STUCK_CLEAR = {
  idle_turns: null,
  fail_tests: null,
  fail_runs: null,
  stuck_nudged: null,
  mid_turn: null,
  mid_fingerprint: null,
  mid_changed: null,
  mid_nudged: null,
  waiting_subagent_since: null,
};

// How long a parent may sit waiting on a subagent before the tick counts it as stalled: a subagent that
// died never wakes its parent.
const SUBAGENT_WAIT_MS = 30 * 60_000;

// The initiative loop, driven by Paseo events rather than a long-running process:
//   Start            marks the initiative loop: on and starts every ready story of its active phase.
//   agent.turn_ended reads the step's marker in the story worktree's .harness/state.md and starts the
//                    next step in a fresh agent: Plan → Implement (one agent per cycle, committed by the
//                    plugin) → Review → the plugin pushes and opens the PR itself.
//   the 2-minute tick watches each open PR: a failing check starts a Fix CI agent, a merge marks the
//                    story merged, archives its workspace and starts the next ready story.
//   supervision      keeps a step moving without an agent watching it. A failed turn, or a turn that
//                    ends without the step's marker, marks the story `stalled` and the tick nudges that
//                    session; a session that is gone, closed or errored is replaced by a fresh one. After
//                    maxRetries the story blocks, and resumes if the step's marker arrives late. A story
//                    whose worktree is gone goes to its branch's PR.
//                    A failed turn that hit the plan's usage limit isn't a retry: the story is paused until
//                    the reset time in the message (an hour on if it names none), then nudged.
//                    Each tick also reads live plan usage from Paseo. While a step's provider is at its limit
//                    the loop starts no story on it and pauses a stalled or dead step (paused_until,
//                    paused_for) instead of nudging into the wall; a retry-limit block from around when the
//                    limit hit goes back to a pause, so it resumes after the reset.
//                    A permission request blocks the story until it's answered.
//                    A turn you cancel is left alone.
//                    Stuck evidence is read from each completed turn: no file edits for stuckTurns turns, or the
//                    same test failing 3 brief test runs in a row. The first time, one nudge names it (no
//                    retry counted); if it still holds on a later turn the story blocks as `stuck`. Progress
//                    resets it; a new step or a reopen starts clean.
//                    The tick also reads a running turn from disk: 3 failing brief logs in a row, or (Implement
//                    only) no change outside .harness/ for 20 minutes. The first time one nudge is steered into
//                    the turn; evidence again after it blocks as `stuck` and interrupts the turn.
//                    A brief run under an hour old isn't idle, a finished one restarts the clock, and a nudge
//                    whose send fails still counts.
//                    Any tool call the timeline shows running isn't idle either; one running over an hour skips
//                    the nudge, which can't land until it returns, and blocks and interrupts at once.
// The story files are the state: the loop writes status, branch, workspace, agent, pr and ci into
// their frontmatter, so it resumes from them after a restart. Paseo owns the worktrees and agents.

type PaseoApi = PluginHandlerContext["paseo"];
type StoryFile = ReturnType<typeof readStoryFiles>[number];
type StoryRef = { repo: string; initiative: string; storyId: string };
type Initiative = { root: string; slug: string; dir: string };

const KIND = LOOP_AGENT_KIND;
// Marks loop workspaces and sessions, like 📐 marks architecture sessions.
const MARK = "🔁";
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
// Repos with an initiative that has been started, so the tick knows where to look.
const REGISTRY = join(homedir(), ".orchestrator", "initiative-loops.json");
const ACTIVE = new Set(["planning", "awaiting-approval", "implementing", "reviewing", "pr-open"]);
// The statuses whose step session the loop supervises. awaiting-approval waits on you and pr-open
// has its own watcher.
const SUPERVISED = new Set(["planning", "implementing", "reviewing"]);
const SUPERVISED_STEPS = new Set<string>(["plan", "diagnose", "implement", "review"]);
// The markers a supervised step answers with; reconcile acts on each of them.
const STEP_ANSWERS: Record<string, string[]> = {
  plan: [MARKERS.planDone],
  diagnose: [MARKERS.diagnoseDone, MARKERS.diagnoseBlocked],
  implement: [MARKERS.implementDone, MARKERS.implementBlocked],
  review: [MARKERS.reviewDone, MARKERS.reviewFailed],
};
const PERMISSION = "permission";
// How long before the loop first saw a plan limit a retry-limit block can be and still be put down to it.
const LIMIT_GRACE_MS = 30 * 60 * 1000;
const STATUS_FOR: Record<LoopStep, string> = {
  plan: "planning",
  diagnose: "planning",
  implement: "implementing",
  review: "reviewing",
  pr: "reviewing",
  fix: "pr-open",
};

const execFileAsync = promisify(execFile);

// Ends a loop agent's prompt when a fresh compact restarts its step in a new session.
export const RESUME_LINE = "Resume from `.harness/state.md`. An earlier session for this step ran out of context.";
// Ends the prompt of a fresh session that replaces one that died mid-step.
export const RESTART_LINE = "Resume from `.harness/state.md`. An earlier session for this step stopped before it finished.";

// The follow-up sent to a stalled step session.
export function nudgePrompt(why: string) {
  return `${why}\n\nCarry on with this step from \`.harness/state.md\`. When it is finished, write the step's marker under ## Status as your first prompt says.`;
}

const readText = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

function readRegistry(): string[] {
  try {
    const parsed: unknown = JSON.parse(readText(REGISTRY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function register(root: string) {
  const repos = readRegistry();
  if (repos.includes(root)) return;
  mkdirSync(dirname(REGISTRY), { recursive: true });
  writeFileSync(REGISTRY, JSON.stringify([...repos, root], null, 2), "utf8");
}

export function initiativeAt(repo: string, slug: string): Initiative {
  const root = resolve(repo);
  if (!SLUG.test(slug)) throw new Error(`${slug} is not an initiative.`);
  const dir = join(initiativesDir(root), slug);
  if (!existsSync(join(dir, "initiative.md"))) throw new Error(`${slug} is not an initiative in ${root}.`);
  return { root, slug, dir };
}

const phaseDirs = (init: Initiative) => dirsIn(join(init.dir, PHASES_DIR)).map((name) => join(init.dir, PHASES_DIR, name));
const phaseMeta = (phaseDir: string) => frontmatter(readText(join(phaseDir, PHASE_FILE)));
const isMerged = (story: StoryFile) => story.meta.status === "merged";

// The first phase with unmerged work. A phase with no stories stops the loop there: it isn't planned yet.
function activePhase(init: Initiative): { phaseDir: string | null; reason: string; done: boolean } {
  const dirs = phaseDirs(init);
  if (dirs.length === 0) return { phaseDir: null, reason: "the initiative has no phases yet", done: false };
  for (const phaseDir of dirs) {
    const stories = readStoryFiles(phaseDir);
    const label = phaseLabel(phaseMeta(phaseDir).phase ?? "");
    if (stories.length === 0) {
      return { phaseDir: null, reason: `${label} has no stories yet; plan its architecture first`, done: false };
    }
    if (!stories.every(isMerged)) return { phaseDir, reason: "", done: false };
  }
  return { phaseDir: null, reason: "every phase is merged", done: true };
}

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: 20_000 });
  return stdout.trim();
}

// initiative.md `base:` wins; otherwise the remote's default branch.
async function baseBranch(init: Initiative) {
  const set = frontmatter(readText(join(init.dir, "initiative.md"))).base;
  if (set) return set.startsWith("origin/") ? set : `origin/${set}`;
  return (await git(init.root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")) || "origin/main";
}

function storyContext(init: Initiative, phaseDir: string, story: StoryFile): StoryContext {
  const meta = phaseMeta(phaseDir);
  const architecture = join(phaseDir, "architecture.md");
  return {
    id: story.id,
    title: story.meta.title || story.id,
    body: story.body,
    ticketKey: story.meta.jira || null,
    ticketUrl: story.meta.jira_url || null,
    storyFile: story.path,
    storiesDir: join(phaseDir, "stories"),
    phaseLabel: phaseLabel(meta.phase ?? ""),
    phaseTitle: meta.title ?? "",
    architectureFile: existsSync(architecture) ? architecture : null,
    initiativeTitle: initiativeTitle(init.dir),
    initiativeFile: join(init.dir, "initiative.md"),
    branch: story.meta.branch ?? "",
    base: story.meta.base ?? "origin/main",
  };
}

const stateFile = (worktree: string) => join(worktree, ".harness", "state.md");

// Keeps what happened to a story in its own file (## Outcome and its counters), which outlives the worktree.
function recordOutcome(story: StoryFile, event: OutcomeEvent) {
  const text = readText(story.path);
  const next = appendOutcome(text, event);
  if (next !== text) writeFileSync(story.path, next, "utf8");
}

// `kind` names what blocked it, so the loop can tell its own give-up from the rest and Retry knows what
// to redo: `start` and `pr` and `ci` need no agent, `retry-limit`, `step` and `stuck` do. A permission wait has none.
// `cost-cap` is a story over its cost cap; `cost-cap-left` is the same block after Leave stopped.
export type BlockKind = "start" | "pr" | "ci" | "retry-limit" | "step" | "stuck" | "cost-cap" | "cost-cap-left";
// What the cost cap needs: the base cap in dollars and the telemetry rows to total a story's spend from.
export type ReadCost = { cap: () => number | Promise<number>; rows: () => TelemetryRow[] | Promise<TelemetryRow[]> };
// A story's cost cap: its own `cost_cap_usd` once Continue has raised it, else the base cap.
function storyCap(story: StoryFile, base: number) {
  const own = Number(story.meta.cost_cap_usd);
  return own > 0 ? own : base;
}
// A permission wait is answered in the session, so it passes `record = false` and stays out of ## Outcome.
function block(story: StoryFile, reason: string, kind?: BlockKind, record = true) {
  if (record) recordOutcome(story, { kind: "blocked", reason });
  writeFrontmatter(story.path, {
    status: "blocked",
    blocked_reason: reason,
    blocked_from: story.meta.status ?? "todo",
    block_kind: kind ?? null,
    blocked_at: new Date().toISOString(),
  });
}

export function createInitiativeLoop(
  readConfig: () => Promise<LoopConfig>,
  readAgentConfig: (api: PaseoApi, step: LoopStep, loop: LoopConfig) => Promise<AgentCreateConfig>,
  // The drawer's phases and skill sources: each step loads its phase's extras.
  readPipeline: () => Promise<{ phases: Phase[]; sources: SkillSource[] }>,
  // The branch prefix (`dm`), or null for none.
  readInitials: () => Promise<string | null> = async () => null,
  // The cost cap: a story at or over it blocks at its turn end. Absent, nothing is capped.
  readCost?: ReadCost,
) {
  let paseo: PaseoApi | null = null;
  // Providers at their plan limit, from the last read of live plan usage: since when the loop has seen
  // it, and until when it holds. In memory only, so a restart forgets `since` until the next read.
  const limits = new Map<string, { since: number; until: number }>();
  // Each step's provider, read once per tick; null when its config can't be read.
  const stepProviders = new Map<LoopStep, string | null>();
  // Steps started by this process, so a repeated event can't start one twice before its label shows.
  const started = new Set<string>();
  // One loop action at a time: Start, turn ends and the tick all read and write the same story files.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };

  // Brings `limits` up to date from Paseo's live plan usage. A daemon that can't answer leaves it as it
  // was, except that a limit whose reset has passed is dropped: nothing can renew it.
  async function refreshLimits(api: PaseoApi) {
    stepProviders.clear();
    const { providers } = await readPlanUsage(api);
    if (!providers) {
      for (const [id, limit] of [...limits]) if (limit.until <= Date.now()) limits.delete(id);
      return;
    }
    const now = new Date();
    const limited = new Set<string>();
    for (const usage of providers) {
      const until = planLimitUntil(usage, now);
      if (!until) continue;
      limited.add(usage.providerId);
      const since = limits.get(usage.providerId)?.since ?? now.getTime();
      limits.set(usage.providerId, { since, until: until.getTime() });
    }
    for (const id of [...limits.keys()]) if (!limited.has(id)) limits.delete(id);
  }

  // The plan limit a step's provider is at, or null when it isn't (or its config can't be read).
  // A model-qualified provider ("claude/opus") is gated by its provider's limit.
  async function limitFor(api: PaseoApi, config: LoopConfig, step: LoopStep) {
    if (!limits.size) return null;
    if (!stepProviders.has(step)) {
      const provider = await readAgentConfig(api, step, config).then(
        (agentConfig) => agentConfig.provider.split("/")[0],
        () => null,
      );
      stepProviders.set(step, provider);
    }
    const provider = stepProviders.get(step);
    const limit = provider ? limits.get(provider) : undefined;
    // A limit that has reset no longer gates, even if the usage read hasn't confirmed it yet.
    return provider && limit && limit.until > Date.now() ? { provider, since: limit.since, until: new Date(limit.until) } : null;
  }

  async function loopAgents(api: PaseoApi) {
    const listed = await api.agents.list({ filter: { includeArchived: false }, page: { limit: 200 } });
    return listed.entries.map((entry) => entry.agent).filter((agent) => agent.labels?.kind === KIND);
  }

  // The `## Plan` paths that Implement, Review or Fix CI can't find on disk. The Plan step writes them,
  // so it isn't checked.
  function planMissing(step: LoopStep, state: string, worktree: string) {
    if (step !== "implement" && step !== "review" && step !== "fix") return [];
    return missingPaths(planPaths(readSection(state, "Plan")), worktree);
  }

  // A resumed agent's skills line: the first prompt's, saved as `step_skills`. A story started
  // before that field existed looks the paths up again, without copying.
  async function resumeSkills(step: LoopStep, meta: StoryFile["meta"]) {
    if (meta.step_skills) return parseSkills(meta.step_skills);
    const { phases, sources } = await readPipeline().catch(() => ({ phases: DEFAULT_PHASES, sources: [] }));
    const extras = stepSkills(step, phases);
    if (!meta.worktree) return extras.map((skill) => ({ name: skill.name }));
    return skillPaths(meta.worktree, extras, sources);
  }

  async function startStep(
    api: PaseoApi,
    config: LoopConfig,
    init: Initiative,
    phaseDir: string,
    story: StoryFile,
    step: LoopStep,
    round: number,
    // attempt: a supervised restart of a step whose session died; it keeps the story's retry count.
    // retry: a Retry from the board, labelled with its time so a closed earlier session doesn't match.
    extra: { failing?: string; cycle?: Cycle; cycles?: Cycle[]; attempt?: number; retry?: string } = {},
  ) {
    const { workspace, worktree } = story.meta;
    if (!workspace || !worktree) throw new Error(`${story.id} has no workspace.`);
    const labels: Record<string, string> = {
      kind: KIND,
      "loop-repo": init.root,
      "loop-initiative": init.slug,
      "loop-phase": basename(phaseDir),
      "loop-story": story.id,
      "loop-step": step,
      "loop-round": String(round),
      ...(extra.cycle ? { "loop-cycle": String(extra.cycle.number) } : {}),
      ...(extra.cycles ? { "loop-cycles": "subagents" } : {}),
      ...(extra.attempt ? { "loop-attempt": String(extra.attempt) } : {}),
      ...(extra.retry ? { "loop-retry": extra.retry } : {}),
    };
    const key = Object.values(labels).join("|");
    if (started.has(key)) return null;
    const existing = (await loopAgents(api)).some((agent) =>
      Object.entries(labels).every(([name, value]) => agent.labels?.[name] === value),
    );
    if (existing) return null;
    started.add(key);
    try {
      const state = readText(stateFile(worktree)) || seedState(storyContext(init, phaseDir, story));
      writeFileSync(stateFile(worktree), writeMarker(state, `${step}-running`), "utf8");
      const ctx = storyContext(init, phaseDir, story);
      const base = extra.cycle ? `${STEP_LABELS[step]} ${extra.cycle.number}` : STEP_LABELS[step];
      const label = round > 1 ? `${base} r${round}` : base;
      const agentConfig = await readAgentConfig(api, step, config);
      // A missing wrapper costs the agent its short test output, not the step.
      await installBrief(worktree, briefTag(step, round, extra.cycle?.number)).catch((error) =>
        console.warn("orchestrator: install brief", story.id, error),
      );
      // Skills help a step but never gate it: a failed read or copy becomes a warning on the story.
      const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
      const warnings: string[] = [];
      const { phases, sources } = await readPipeline().catch((error) => {
        warnings.push(`pipeline: ${reason(error)}`);
        return { phases: DEFAULT_PHASES, sources: [] };
      });
      const extras = stepSkills(step, phases);
      warnings.push(...(await installSkills(worktree, extras, sources).catch((error) => [`skills: ${reason(error)}`])));
      for (const warning of warnings) console.warn("orchestrator: skills", story.id, warning);
      const skills = await skillPaths(worktree, extras, sources);
      const prompt = stepPrompt(step, ctx, {
        round,
        failing: extra.failing,
        cycle: extra.cycle,
        cycles: extra.cycles,
        plan: readSection(state, "Plan"),
        missing: planMissing(step, state, worktree),
        skills,
      });
      // Story steps work from the story file and the worktree; none of them needs an MCP server.
      const agent = await withMcpScope(worktree, "none", () =>
        api.workspaces.ref(workspace).agents.create({
          title: `${MARK} ${story.id} · ${label} — ${ctx.title}`.slice(0, 60),
          config: agentConfig,
          prompt: extra.attempt ? `${prompt}\n\n${RESTART_LINE}` : prompt,
          labels,
        }),
      );
      writeFrontmatter(story.path, {
        status: STATUS_FOR[step],
        ...(step === "fix"
          ? {}
          : { step, round, cycle: extra.cycle?.number ?? null, cycles: extra.cycles ? "subagents" : null }),
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
        ...(extra.attempt ? {} : { retries: null }),
        ...STUCK_CLEAR,
        skill_warnings: warnings.join(" · ") || null,
        // The first prompt's skills line, so a resumed agent gets the same one.
        step_skills: formatSkills(skills) || null,
      });
      return agent.id;
    } catch (error) {
      started.delete(key);
      throw error;
    }
  }

  // Creates (or reuses) the story's worktree workspace and starts its first step: Diagnose on the diagnose track, else Plan.
  async function startStory(api: PaseoApi, config: LoopConfig, init: Initiative, phaseDir: string, story: StoryFile) {
    const base = story.meta.base || (await baseBranch(init));
    const branch =
      story.meta.branch ||
      (await uniqueBranch(init.root, branchName({ initials: await readInitials(), title: story.meta.title || story.id })));
    const title = `${MARK} ${story.id} — ${story.meta.title || story.id}`.slice(0, 60);

    let workspaceId = story.meta.workspace || "";
    let worktree = story.meta.worktree || "";
    const reusable = workspaceId ? await api.workspaces.ref(workspaceId).refresh().catch(() => null) : null;
    if (!reusable || !worktree || !existsSync(worktree)) {
      // Saved first: if Paseo makes the branch and then fails, the retry reuses it instead of adding -2.
      if (!story.meta.branch) writeFrontmatter(story.path, { branch });
      const { projects } = await api.projects.list().catch(() => ({ projects: [] as { projectId: string; projectRootPath: string }[] }));
      const project = projects.find((item) => resolve(item.projectRootPath) === init.root);
      const created = await api.workspaces.create({
        title,
        source: {
          kind: "worktree",
          cwd: init.root,
          ...(project ? { projectId: project.projectId } : {}),
          action: "branch-off",
          baseBranch: base,
          branchName: branch,
          worktreeSlug: slugOf(`${init.slug}-${story.id}`),
        },
      });
      workspaceId = created.id;
      worktree = created.directory ?? (await created.refresh())?.workspaceDirectory ?? "";
      if (!worktree) throw new Error("Paseo created the workspace but did not report its folder.");
    }
    await excludeHarness(init.root);
    mkdirSync(join(worktree, ".harness"), { recursive: true });
    writeFrontmatter(story.path, { branch, base, workspace: workspaceId, worktree });
    const fresh = readStoryFiles(phaseDir).find((item) => item.id === story.id) ?? story;
    if (!existsSync(stateFile(worktree))) writeFileSync(stateFile(worktree), seedState(storyContext(init, phaseDir, fresh)), "utf8");
    return startStep(api, config, init, phaseDir, fresh, fresh.meta.track === "diagnose" ? "diagnose" : "plan", 1);
  }

  // Moves an in-flight story to its next step from the marker its current step wrote.
  async function reconcile(api: PaseoApi, config: LoopConfig, init: Initiative, phaseDir: string, given: StoryFile, turnEnded: boolean) {
    const story = resumeLateAnswer(phaseDir, given);
    const { meta } = story;
    if (!meta.worktree || !ACTIVE.has(meta.status ?? "") || meta.status === "pr-open") return;
    const state = readText(stateFile(meta.worktree));
    if (!state) return;
    // The tick can see a marker an agent wrote mid-turn. Wait for its turn to end before committing
    // its work and moving on; the turn-end event does that.
    if (!turnEnded && meta.agent) {
      const status = (await api.agents.ref(meta.agent).refresh().catch(() => null))?.agent.status;
      if (status === "running" || status === "initializing") return;
    }
    const { marker, detail } = readMarker(state);
    const step = meta.step as LoopStep;
    const round = Number(meta.round) || 1;
    const on = initiativeLoopState(init.dir) === "on";
    const next = (to: LoopStep, nextRound: number, cycle?: Cycle) =>
      on ? startStep(api, config, init, phaseDir, story, to, nextRound, { cycle }) : null;
    // Round 1 with cycles left: one parent that runs them in subagents, or the next cycle's own agent
    // with `subagentCycles` off.
    const nextImplement = (cycle: Cycle | undefined) => {
      const open = readCycles(state).filter((item) => !item.done);
      if (!on || !config.subagentCycles || !open.length) return next("implement", 1, cycle);
      return startStep(api, config, init, phaseDir, story, "implement", 1, { cycles: open });
    };

    if (step === "plan") {
      if (marker === MARKERS.planDone) await nextImplement(readCycles(state).find((cycle) => !cycle.done));
      // The planner ended its turn without approval: it is asking you.
      else if (turnEnded && meta.status === "planning") writeFrontmatter(story.path, { status: "awaiting-approval" });
    } else if (step === "diagnose") {
      // No gate: Diagnose hands its plan straight to Implement. A turn end without a marker is a stall.
      if (marker === MARKERS.diagnoseDone) await nextImplement(readCycles(state).find((cycle) => !cycle.done));
      else if (marker === MARKERS.diagnoseBlocked) block(story, detail || "Diagnose is blocked; open its session.", "step");
    } else if (step === "implement") {
      if (marker === MARKERS.implementDone) {
        // A parent that ran the cycles in subagents must have ticked them all.
        const finished = meta.cycles === "subagents" ? "all" : meta.cycle ? Number(meta.cycle) : null;
        const after = afterImplement(state, finished);
        if (after.kind === "blocked") {
          block(story, after.reason, "step");
          return;
        }
        const cycle = typeof finished === "number" ? (readCycles(state).find((item) => item.number === finished) ?? null) : null;
        const fallback = cycle ? cycle.name : round > 1 ? "Fix review findings" : story.meta.title || story.id;
        await commitStory(meta.worktree, commitSubject(state, fallback));
        if (after.kind === "cycle") await (round === 1 ? nextImplement(after.cycle) : next("implement", round, after.cycle));
        else await next("review", round);
      } else if (marker === MARKERS.implementBlocked) block(story, detail || "Implement is blocked; open its session.", "step");
    } else if (step === "review") {
      if (marker === MARKERS.reviewDone || marker === MARKERS.reviewFailed) {
        // The checklist under ## Review findings decides, not the marker (afterReview).
        const after = afterReview(state, marker, round, config.reviewRounds);
        if (after.kind !== "pr") {
          recordOutcome(story, { kind: "review-failed", round, findings: readSection(state, "Review findings").split("\n") });
        }
        if (after.kind === "fix") await next("implement", round + 1);
        else if (after.kind === "blocked") block(story, after.reason, "step");
        else if (on) await openPr(init, phaseDir, story, after.unfixed);
      }
    } else if (step === "pr" && marker === MARKERS.prDone) {
      const pr = await prForBranch(meta.worktree, meta.branch ?? "");
      if (pr) writeFrontmatter(story.path, { status: "pr-open", pr: pr.number, ci: "pending" });
      else if (turnEnded) block(story, `Open PR finished but there is no open PR for ${meta.branch}.`, "pr");
    }
  }

  // The loop gave up on a step whose session was still working: once that step writes its answer,
  // put the story back where it was so reconcile acts on it.
  function resumeLateAnswer(phaseDir: string, story: StoryFile) {
    const { meta } = story;
    if (meta.status !== "blocked" || meta.block_kind !== "retry-limit" || !meta.worktree) return story;
    const marker = readMarker(readText(stateFile(meta.worktree))).marker ?? "";
    if (!STEP_ANSWERS[meta.step ?? ""]?.includes(marker)) return story;
    writeFrontmatter(story.path, {
      status: meta.blocked_from ?? null,
      blocked_reason: null,
      blocked_from: null,
      blocked_at: null,
      retries: null,
      stalled: null,
      paused_until: null,
      paused_for: null,
      block_kind: null,
    });
    return readStoryFiles(phaseDir).find((item) => item.id === story.id) ?? story;
  }

  // Review passed: the plugin commits leftovers, pushes and opens the PR. No agent is needed for this.
  async function openPr(init: Initiative, phaseDir: string, story: StoryFile, unfixed: string[] = []) {
    const { meta } = story;
    if (!meta.worktree) return;
    const ctx = storyContext(init, phaseDir, story);
    try {
      const subject = commitSubject(readText(stateFile(meta.worktree)), "Commit remaining changes");
      const pr = await openStoryPr(meta.worktree, { id: story.id, title: ctx.title, jira: false, branch: meta.branch ?? "", base: ctx.base, subject, unfixed });
      // Nothing to ship: the work is already on the base, so the story is done and its dependents can go.
      if (!pr) {
        recordOutcome(story, { kind: "no-change" });
        writeFrontmatter(story.path, {
          status: "merged",
          merged_at: new Date().toISOString(),
          step: "pr",
          round: 1,
          cycle: null,
          agent: null,
          ci: null,
        });
        refreshInitiativeIndex(init.dir);
        return;
      }
      writeFileSync(stateFile(meta.worktree), writeMarker(readText(stateFile(meta.worktree)), `${MARKERS.prDone}\n${pr.url}`), "utf8");
      writeFrontmatter(story.path, { status: "pr-open", step: "pr", round: 1, cycle: null, agent: null, pr: pr.number, ci: "pending" });
    } catch (error) {
      block(story, `Could not open the PR: ${failureText(error)}`, "pr");
    }
  }

  // A Fix CI agent finished: commit and push its change so CI runs again.
  async function finishFix(story: StoryFile) {
    const { meta } = story;
    if (!meta.worktree || meta.status !== "pr-open") return;
    const state = readText(stateFile(meta.worktree));
    if (readMarker(state).marker !== MARKERS.fixDone) return;
    try {
      await pushStoryFix(meta.worktree, commitSubject(state, "Fix failing CI checks"));
    } catch (error) {
      block(story, `Could not push the CI fix: ${failureText(error)}`, "ci");
    }
  }

  // An open story PR: record merges and CI, and start a Fix CI agent for a new failure.
  async function watchPr(api: PaseoApi, config: LoopConfig, init: Initiative, phaseDir: string, story: StoryFile) {
    const { meta } = story;
    const cwd = meta.worktree && existsSync(meta.worktree) ? meta.worktree : init.root;
    const pr = await prStatus(cwd, meta.pr || meta.branch || "");
    if (!pr) return;
    const action = ciAction(pr, { fixedSha: meta.fixed_sha ?? null, attempts: Number(meta.fix_attempts) || 0 }, config.maxFixes);
    if (action.kind === "merged") {
      recordOutcome(story, { kind: "merged" });
      writeFrontmatter(story.path, { status: "merged", merged_at: pr.mergedAt || new Date().toISOString(), ci: null, agent: null });
      if (meta.workspace) await api.workspaces.archive(meta.workspace).catch(() => undefined);
      refreshInitiativeIndex(init.dir);
      return;
    }
    if (action.kind === "closed") {
      block(story, `PR #${pr.number} was closed without merging.`, "pr");
      return;
    }
    if (meta.ci !== action.ci) writeFrontmatter(story.path, { ci: action.ci });
    if (action.kind === "wait" || initiativeLoopState(init.dir) !== "on") return;
    if (action.kind === "give-up") {
      block(story, action.reason, "ci");
      return;
    }
    // The outcome entry counts the attempt (fix_attempts); the head is kept so it isn't fixed twice.
    recordOutcome(story, { kind: "fix", attempt: action.attempt, checks: pr.failing.map((check) => check.name) });
    writeFrontmatter(story.path, { fixed_sha: action.headSha });
    const fresh = readStoryFiles(phaseDir).find((item) => item.id === story.id) ?? story;
    await startStep(api, config, init, phaseDir, fresh, "fix", action.attempt, { failing: await failureReport(cwd, pr.failing) });
  }

  // Fills free slots in the active phase with ready stories.
  async function advance(api: PaseoApi, config: LoopConfig, init: Initiative) {
    const startedNow: { story: string; agentId: string }[] = [];
    if (initiativeLoopState(init.dir) !== "on") return { started: startedNow, reason: "the loop is off" };
    const { phaseDir, reason, done } = activePhase(init);
    if (done) {
      writeFrontmatter(join(init.dir, "initiative.md"), { loop: "done" });
      return { started: startedNow, reason };
    }
    if (!phaseDir) return { started: startedNow, reason };
    if (inHoldWindow(config.holdFrom, config.holdUntil, new Date())) {
      return { started: startedNow, reason: `holding new stories from ${config.holdFrom}:00 to ${config.holdUntil}:00` };
    }
    const merged = new Set(phaseDirs(init).flatMap((dir) => readStoryFiles(dir).filter(isMerged).map((story) => story.id)));
    const stories = readStoryFiles(phaseDir);
    // A step stopped by the plan's usage limit in its reply says the next one would stop too. A pause
    // from live usage names its provider, and the gate below holds only stories on that provider.
    if (stories.some((story) => !story.meta.paused_for && Date.parse(story.meta.paused_until ?? "") > Date.now())) {
      return { started: startedNow, reason: "paused until the usage limit resets" };
    }
    // A story blocked on a permission request still has its session open, so it keeps its slot.
    const inFlight = stories.filter(
      (story) => ACTIVE.has(story.meta.status ?? "") || story.meta.waiting_on === PERMISSION,
    ).length;
    const ready = stories.filter(
      (story) =>
        (story.meta.status || "todo") === "todo" &&
        !story.meta.blocked_by &&
        (story.meta.depends_on ?? "").split(",").map((id) => id.trim()).filter(Boolean).every((id) => merged.has(id)),
    );
    let paused = "";
    for (const story of ready.slice(0, Math.max(0, config.parallel - inFlight))) {
      // Its first step's provider is at its plan limit: starting it would only hit the wall.
      const limit = await limitFor(api, config, story.meta.track === "diagnose" ? "diagnose" : "plan");
      if (limit) {
        paused = `paused for the ${providerName(limit.provider)} limit until ${clockTime(limit.until)}`;
        continue;
      }
      try {
        const agentId = await startStory(api, config, init, phaseDir, story);
        if (agentId) startedNow.push({ story: story.id, agentId });
      } catch (error) {
        block(story, `Could not start: ${error instanceof Error ? error.message : String(error)}`, "start");
      }
    }
    const running = inFlight + startedNow.length;
    if (paused && !startedNow.length) return { started: startedNow, reason: paused };
    const label = phaseLabel(phaseMeta(phaseDir).phase ?? "");
    return {
      started: startedNow,
      reason: running > 0 ? `${label}: ${running} ${running === 1 ? "story" : "stories"} in flight` : `${label}: nothing ready (blocked or waiting on dependencies)`,
    };
  }

  // Keeps an in-flight step moving when its session can't. A session that is gone, closed or errored
  // gets a fresh one; a stalled one (a failed turn, or a turn that ended without the step's marker)
  // gets a nudge. Each counts as a retry; past maxRetries the story blocks for you.
  async function supervise(api: PaseoApi, config: LoopConfig, init: Initiative, phaseDir: string, story: StoryFile) {
    const { meta } = story;
    const step = meta.step as LoopStep;
    if (!meta.worktree || !meta.agent || !SUPERVISED.has(meta.status ?? "") || !SUPERVISED_STEPS.has(step)) return;
    if (!existsSync(meta.worktree)) {
      await worktreeGone(api, config, init, phaseDir, story);
      return;
    }
    const state = readText(stateFile(meta.worktree));
    // Any other marker is the step's own answer, and reconcile acts on it.
    if (readMarker(state).marker !== `${step}-running`) return;
    // Stopped by the plan's usage limit: wait out the reset (and any hold), then nudge without counting a retry.
    const pausedUntil = Date.parse(meta.paused_until ?? "");
    const resuming = !Number.isNaN(pausedUntil);
    if (resuming && (Date.now() < pausedUntil || inHoldWindow(config.holdFrom, config.holdUntil, new Date()))) return;
    const session = await api.agents
      .ref(meta.agent)
      .refresh()
      .then((found) => found?.agent ?? null, () => undefined);
    // Paseo didn't answer: that says nothing about the session, so try again next tick.
    if (session === undefined) return;
    if (session?.status === "running" && session.activeTurn) {
      await midTurnWatch(api, story, step, session.activeTurn);
      return;
    }
    if (session?.status === "running" || session?.status === "initializing") return;
    const dead = !session || Boolean(session.archivedAt) || session.status === "closed" || session.status === "error";
    const waitedSince = Date.parse(meta.waiting_subagent_since ?? "");
    const waitedOut = !Number.isNaN(waitedSince) && Date.now() - waitedSince >= SUBAGENT_WAIT_MS;
    if (!dead && !meta.stalled && !resuming && !waitedOut) return;
    // Its provider is at its plan limit (or still is, past an earlier pause): wait out the reset rather
    // than nudge or restart into it. Not a retry.
    const limit = await limitFor(api, config, step);
    if (limit) {
      writeFrontmatter(story.path, { paused_until: limit.until.toISOString(), paused_for: limit.provider, stalled: null });
      return;
    }
    const why = dead
      ? session?.lastError
        ? `Its session failed: ${session.lastError}.`
        : "Its session is gone."
      : meta.stalled ||
        (resuming ? "The usage limit has reset." : `It waited on a subagent for over ${SUBAGENT_WAIT_MS / 60_000} minutes.`);
    if (resuming && !dead) {
      writeFrontmatter(story.path, { paused_until: null, paused_for: null, stalled: null });
      await api.agents.ref(meta.agent).send(nudgePrompt(why));
      return;
    }
    const retries = Number(meta.retries) || 0;
    if (retries >= config.maxRetries) {
      block(story, `${STEP_LABELS[step]}: ${why} Gave up after ${retries} ${retries === 1 ? "retry" : "retries"}.`, "retry-limit");
      return;
    }
    writeFrontmatter(story.path, { retries: retries + 1, stalled: null, paused_until: null, paused_for: null, waiting_subagent_since: null });
    if (!dead) {
      await api.agents.ref(meta.agent).send(nudgePrompt(why));
      return;
    }
    const fresh = readStoryFiles(phaseDir).find((item) => item.id === story.id) ?? story;
    const cycle = meta.cycle ? readCycles(state).find((item) => String(item.number) === meta.cycle) : undefined;
    // A subagent-cycles parent comes back as a parent, with the cycles still open.
    const cycles = meta.cycles === "subagents" ? readCycles(state).filter((item) => !item.done) : undefined;
    await startStep(api, config, init, phaseDir, fresh, step, Number(meta.round) || 1, {
      cycle,
      cycles,
      attempt: retries + 1,
    });
  }

  // When each agent's running turn was first seen, for a turn whose start time Paseo didn't report.
  const turnSeen = new Map<string, { turnId: string; at: number }>();

  // Reads a running turn's progress from disk (the brief logs since it started) and the timeline (a tool
  // call still running). The first evidence is one nudge steered into the running turn, so it isn't
  // interrupted; the nudge is shared with the turn-end check (`stuck_nudged`). A send that fails still
  // records the nudge, so the next evidence blocks rather than retrying the nudge every tick.
  async function midTurnWatch(
    api: PaseoApi,
    story: StoryFile,
    step: LoopStep,
    turn: { turnId: string; startedAt: string | null },
  ) {
    const { meta } = story;
    if (!meta.worktree || !meta.agent) return;
    // A new turn starts the mid-turn fields over.
    if (meta.mid_turn !== turn.turnId) {
      writeFrontmatter(story.path, { mid_turn: turn.turnId, mid_fingerprint: null, mid_changed: null, mid_nudged: null });
    }
    const carried = meta.mid_turn === turn.turnId;
    let seen = turnSeen.get(meta.agent);
    if (seen?.turnId !== turn.turnId) turnSeen.set(meta.agent, (seen = { turnId: turn.turnId, at: Date.now() }));
    const startedMs = Date.parse(turn.startedAt ?? "");
    const turnStart = Number.isNaN(startedMs) ? seen.at : startedMs;
    // After the nudge, only runs made since it count as evidence again.
    const nudgedMs = carried ? Date.parse(meta.mid_nudged ?? "") : Number.NaN;
    const since = Number.isNaN(nudgedMs) ? turnStart : Math.max(turnStart, nudgedMs);
    const logged = briefRuns(meta.worktree, step, since);
    const runs = logged.map((run) => run.failures);
    const subagents = meta.cycles === "subagents";
    const now = Date.now();
    // Only Implement judges idleness, so only it pays for the git work.
    const idleWatch = step === "implement" && !subagents;
    const fingerprint = idleWatch ? worktreeFingerprint(meta.worktree) : null;
    const testRunning = idleWatch && activeBriefRuns(meta.worktree, step, now).length > 0;
    const toolRunningSinceMs = idleWatch ? await runningToolSince(api, meta.agent, turn.turnId) : null;
    const lastRunMs = logged.length > 0 ? logged[logged.length - 1].mtimeMs : null;
    const stored = { fingerprint: carried ? meta.mid_fingerprint || null : null, changed: carried ? meta.mid_changed || null : null };
    const { mid, evidence, progressed, interrupt } = midTurnCheck({
      runs, fingerprint, now, mid: stored, step, subagents, testRunning, lastRunMs, toolRunningSinceMs,
    });
    if (mid.fingerprint !== stored.fingerprint || mid.changed !== stored.changed) {
      writeFrontmatter(story.path, { mid_fingerprint: mid.fingerprint, mid_changed: mid.changed });
    }
    // Progress after a nudge starts the spell over.
    if (progressed) {
      if (meta.stuck_nudged || meta.mid_nudged) writeFrontmatter(story.path, { stuck_nudged: null, mid_nudged: null });
      return;
    }
    if (!evidence) return;
    // Already nudged (here or at a turn end), or stuck inside one call a steer can't reach: block, then
    // stop the running turn.
    if (interrupt || meta.stuck_nudged || (carried && meta.mid_nudged)) {
      block(story, `stuck: ${evidence}`, "stuck");
      await api.agents
        .ref(meta.agent)
        .send(`The loop blocked this story as stuck: ${evidence}; stop and wait.`, { activeTurnBehavior: "interrupt" })
        .catch(() => undefined);
      return;
    }
    const text = nudgePrompt(`You look stuck: ${evidence}.`);
    await api.agents.ref(meta.agent).send(text, { activeTurnBehavior: "steer" }).catch(() => undefined);
    // Idleness is judged again from the nudge, not from the stale edit time.
    const nudgedAt = new Date().toISOString();
    writeFrontmatter(story.path, { stuck_nudged: 1, mid_nudged: nudgedAt, mid_changed: nudgedAt });
  }

  // When the oldest tool call running in the agent's turn started, from the timeline's tail. Null when
  // none is running, or Paseo didn't answer, so missing data never counts against the step.
  async function runningToolSince(api: PaseoApi, agent: string, turnId: string): Promise<number | null> {
    try {
      const page = await api.agents.ref(agent).timeline.refetch({ direction: "tail", limit: 50, projection: "projected" });
      return page.error ? null : toolRunningSince(page.entries as readonly TimelineEntry[], turnId);
    } catch {
      return null;
    }
  }

  // A story's worktree was removed mid-step, so there is nothing to resume. Its work went somewhere,
  // usually a PR opened and merged outside the loop: hand an open or merged PR to the PR watcher so
  // the story stops holding a slot. A closed PR blocks it for you. No PR counts as a retry, since gh
  // being down looks the same, and blocks it past maxRetries.
  async function worktreeGone(api: PaseoApi, config: LoopConfig, init: Initiative, phaseDir: string, story: StoryFile) {
    const { meta } = story;
    const pr = meta.branch ? await prStatus(init.root, meta.branch) : null;
    if (pr?.state === "closed") {
      block(story, `Its worktree is gone and PR #${pr.number} was closed without merging.`, "pr");
      return;
    }
    if (!pr) {
      const retries = Number(meta.retries) || 0;
      if (retries >= config.maxRetries) block(story, `Its worktree is gone and ${meta.branch || "its branch"} has no PR.`, "pr");
      else writeFrontmatter(story.path, { retries: retries + 1 });
      return;
    }
    writeFrontmatter(story.path, { status: "pr-open", step: "pr", round: 1, cycle: null, agent: null, retries: null, pr: pr.number, ci: "pending" });
    const fresh = readStoryFiles(phaseDir).find((item) => item.id === story.id) ?? story;
    await watchPr(api, config, init, phaseDir, fresh);
  }

  // A story the loop gave up on while its step's provider was hitting its plan limit: those retries
  // went into the wall, so it goes back to its step as a pause and resumes after the reset. A block
  // from well before the limit began (30 minutes' grace) had another cause and stays. `since` is when
  // this process first saw the limit, so after a restart only blocks from then on are recovered. Each
  // story is recovered once per limit (limit_recovered), so a long weekly limit can't loop it.
  async function recoverLimitBlock(api: PaseoApi, config: LoopConfig, story: StoryFile) {
    const { meta } = story;
    const step = meta.step as LoopStep;
    if (meta.status !== "blocked" || meta.block_kind !== "retry-limit" || !SUPERVISED_STEPS.has(step)) return false;
    const blockedAt = Date.parse(meta.blocked_at ?? "");
    const limit = Number.isNaN(blockedAt) ? null : await limitFor(api, config, step);
    if (!limit || blockedAt < limit.since - LIMIT_GRACE_MS) return false;
    // Once per limit episode: a story that blocks again in the same one is broken, not caught by it.
    const episode = new Date(limit.since).toISOString();
    if (meta.limit_recovered === episode) return false;
    writeFrontmatter(story.path, {
      limit_recovered: episode,
      status: meta.blocked_from ?? null,
      blocked_reason: null,
      blocked_from: null,
      blocked_at: null,
      block_kind: null,
      retries: null,
      stalled: null,
      paused_until: limit.until.toISOString(),
      paused_for: limit.provider,
    });
    return true;
  }

  // Everything the loop does for one initiative on a tick: PRs, in-flight steps, then free slots.
  async function sweep(api: PaseoApi, config: LoopConfig, init: Initiative) {
    for (const phaseDir of phaseDirs(init)) {
      for (const story of readStoryFiles(phaseDir)) {
        try {
          if (story.meta.status === "pr-open") await watchPr(api, config, init, phaseDir, story);
          else if (initiativeLoopState(init.dir) === "on") {
            await reconcile(api, config, init, phaseDir, story, false);
            let fresh = readStoryFiles(phaseDir).find((item) => item.id === story.id);
            if (fresh && (await recoverLimitBlock(api, config, fresh))) {
              fresh = readStoryFiles(phaseDir).find((item) => item.id === story.id);
            }
            if (fresh) await supervise(api, config, init, phaseDir, fresh);
          }
        } catch (error) {
          console.warn("orchestrator: initiative loop", init.slug, story.id, error);
        }
      }
    }
    return advance(api, config, init);
  }

  // The story a loop agent's labels point at, or null when it is gone.
  function labelledStory(labels: Record<string, string>) {
    if (labels.kind !== KIND || !labels["loop-repo"] || !labels["loop-initiative"]) return null;
    let init: Initiative;
    try {
      init = initiativeAt(labels["loop-repo"], labels["loop-initiative"]);
    } catch {
      return null;
    }
    const phaseDir = join(init.dir, PHASES_DIR, labels["loop-phase"] ?? "");
    const story = readStoryFiles(phaseDir).find((item) => item.id === labels["loop-story"]);
    return story ? { init, phaseDir, story } : null;
  }

  // A story by its id in any phase of the initiative, with both, or null when either isn't there.
  function locateStory(input: StoryRef) {
    let init: Initiative;
    try {
      init = initiativeAt(input.repo, input.initiative);
    } catch {
      return null;
    }
    for (const phaseDir of phaseDirs(init)) {
      const story = readStoryFiles(phaseDir).find((item) => item.id === input.storyId);
      if (story) return { init, phaseDir, story };
    }
    return null;
  }

  const findStory = (input: StoryRef) => locateStory(input)?.story ?? null;

  return {
    rememberPaseo(next: PaseoApi) {
      paseo = next;
    },

    start(api: PaseoApi, input: { repo: string; initiative: string }) {
      paseo = api;
      return serial(async () => {
        try {
          const init = initiativeAt(input.repo, input.initiative);
          register(init.root);
          writeFrontmatter(join(init.dir, "initiative.md"), { loop: "on" });
          await refreshLimits(api);
          const result = await sweep(api, await readConfig(), init);
          return { ok: true, error: null, ...result };
        } catch (cause) {
          return { ok: false, error: cause instanceof Error ? cause.message : String(cause), started: [], reason: "" };
        }
      });
    },

    stop(input: { repo: string; initiative: string }) {
      return serial(async () => {
        try {
          const init = initiativeAt(input.repo, input.initiative);
          writeFrontmatter(join(init.dir, "initiative.md"), { loop: "off" });
          return { ok: true, error: null };
        } catch (cause) {
          return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
        }
      });
    },

    // A fresh compact's prompt for a loop agent: its step prompt rebuilt from the story files, plus
    // the resume line. A cycle agent gets its cycle and the plan back, as startStep gave them.
    // A Fix CI resume has no failure report; the prompt points at the PR's checks.
    async resumePrompt(labels: Record<string, string>): Promise<string | null> {
      const found = labelledStory(labels);
      const step = labels["loop-step"] as LoopStep | undefined;
      if (!found || !step || !(step in STEP_LABELS)) return null;
      const ctx = storyContext(found.init, found.phaseDir, found.story);
      const state = found.story.meta.worktree ? readText(stateFile(found.story.meta.worktree)) : "";
      const cycle = labels["loop-cycle"]
        ? readCycles(state).find((item) => String(item.number) === labels["loop-cycle"])
        : undefined;
      // A parent gets back only the cycles it hasn't ticked yet.
      const cycles =
        labels["loop-cycles"] === "subagents" ? readCycles(state).filter((item) => !item.done) : undefined;
      const prompt = stepPrompt(step, ctx, {
        round: Number(labels["loop-round"]) || 1,
        cycle,
        cycles,
        plan: readSection(state, "Plan"),
        missing: found.story.meta.worktree ? planMissing(step, state, found.story.meta.worktree) : [],
        skills: await resumeSkills(step, found.story.meta),
      });
      return `${prompt}\n\n${RESUME_LINE}`;
    },

    // After a fresh compact, the story's `agent:` follows the new session. Only when it still
    // names the old one, so a step that already moved on is left alone.
    handOver(labels: Record<string, string>, fromId: string, toId: string): Promise<void> {
      return serial(async () => {
        const found = labelledStory(labels);
        if (found?.story.meta.agent === fromId) writeFrontmatter(found.story.path, { agent: toId });
      });
    },

    // Whether this session still owns its step: the story's `agent:` is it and the step's marker is
    // `<step>-running`. A step that wrote `-done` or moved on is not, so the context watch leaves it alone.
    stepActive(labels: Record<string, string>, agentId: string): Promise<boolean> {
      return serial(async () => {
        const found = labelledStory(labels);
        const step = labels["loop-step"];
        const worktree = found?.story.meta.worktree;
        if (!found || !step || !worktree || found.story.meta.agent !== agentId) return false;
        return readMarker(readText(stateFile(worktree))).marker === `${step}-running`;
      });
    },

    // A story's gate fields, from whichever phase holds it; null when the initiative or story isn't there.
    gateStory(input: StoryRef) {
      return serial(async () => {
        const story = findStory(input);
        if (!story) return null;
        return {
          status: story.meta.status ?? "",
          agent: story.meta.agent || null,
          waitingOn: story.meta.waiting_on || null,
          blockKind: (story.meta.block_kind || null) as BlockKind | null,
        };
      });
    },

    // Whether the story's step marker is still `<step>-running`; false when there is no step or worktree.
    stepRunning(input: StoryRef): Promise<boolean> {
      return serial(async () => {
        const meta = findStory(input)?.meta;
        if (!meta?.step || !meta.worktree) return false;
        return readMarker(readText(stateFile(meta.worktree))).marker === `${meta.step}-running`;
      });
    },

    // A gate action got the agent going again: the story goes back to the step it blocked from, with
    // its retries reset, so the marker flow and supervision pick it up. A CI block gets a fresh fix
    // budget, and a step block's marker goes back to running so reconcile doesn't block it again.
    // Only a blocked story that knows where it came from moves; anything else is left alone.
    reopen(input: StoryRef): Promise<void> {
      return serial(async () => {
        const story = findStory(input);
        if (story?.meta.status !== "blocked" || !story.meta.blocked_from) return;
        const kind = story.meta.block_kind;
        if (kind === "step" && story.meta.step && story.meta.worktree) {
          const state = readText(stateFile(story.meta.worktree));
          if (state) writeFileSync(stateFile(story.meta.worktree), writeMarker(state, `${story.meta.step}-running`), "utf8");
        }
        writeFrontmatter(story.path, {
          status: story.meta.blocked_from,
          blocked_reason: null,
          blocked_from: null,
          blocked_at: null,
          limit_recovered: null,
          block_kind: null,
          waiting_on: null,
          stalled: null,
          paused_until: null,
          paused_for: null,
          retries: null,
          ...STUCK_CLEAR,
          ...(kind === "ci" ? { fix_attempts: null, fixed_sha: null } : {}),
        });
      });
    },

    // Continue on a cost-cap block (or Retry on one that was left): the story's cap goes up by the base
    // cap and the story goes back to the step it blocked from. The state.md marker is left as it is, so
    // the caller decides whether anything needs waking. Any other block is refused and left alone.
    raiseCap(input: StoryRef): Promise<void> {
      return serial(async () => {
        const story = findStory(input);
        const kind = story?.meta.block_kind;
        if (!story || !readCost || story.meta.status !== "blocked" || (kind !== "cost-cap" && kind !== "cost-cap-left")) return;
        if (!story.meta.blocked_from) return;
        const base = await readCost.cap();
        writeFrontmatter(story.path, {
          cost_cap_usd: storyCap(story, base) + base,
          status: story.meta.blocked_from,
          blocked_reason: null,
          blocked_from: null,
          blocked_at: null,
          block_kind: null,
          waiting_on: null,
          stalled: null,
          paused_until: null,
          paused_for: null,
          retries: null,
        });
      });
    },

    // Leave stopped on a cost-cap block: it stays blocked on the board but is marked as left, so it
    // drops out of Needs you. Only a story blocked on a cost cap is touched.
    leaveStopped(input: StoryRef): Promise<void> {
      return serial(async () => {
        const story = findStory(input);
        if (story?.meta.status !== "blocked" || story.meta.block_kind !== "cost-cap") return;
        writeFrontmatter(story.path, { block_kind: "cost-cap-left" });
      });
    },

    // Retry on a blocked step whose session ended or is gone: the step starts again in a fresh session,
    // same step, round and cycle, as supervise does for a dead session. startStep clears the block.
    // Anything but a blocked agent step is refused and left alone; startStep's own error comes back as is.
    retryStep(api: PaseoApi, input: StoryRef): Promise<{ ok: boolean; error: string | null; agentId: string | null }> {
      paseo = api;
      return serial(async () => {
        const found = locateStory(input);
        if (!found) return { ok: false, error: `${input.storyId} isn't on that board.`, agentId: null };
        const { init, phaseDir, story } = found;
        const { meta } = story;
        if (meta.status !== "blocked") return { ok: false, error: `${story.id} isn't blocked.`, agentId: null };
        const step = meta.step as LoopStep | undefined;
        if (!step || !SUPERVISED_STEPS.has(step)) {
          return { ok: false, error: `${story.id} has no step to start again.`, agentId: null };
        }
        // A cost-cap block raises its cap first, so the fresh step isn't blocked again on its first turn end.
        if (readCost && (meta.block_kind === "cost-cap" || meta.block_kind === "cost-cap-left")) {
          const base = await readCost.cap();
          writeFrontmatter(story.path, { cost_cap_usd: storyCap(story, base) + base });
        }
        try {
          const state = meta.worktree ? readText(stateFile(meta.worktree)) : "";
          const cycle = meta.cycle ? readCycles(state).find((item) => String(item.number) === meta.cycle) : undefined;
          const cycles = meta.cycles === "subagents" ? readCycles(state).filter((item) => !item.done) : undefined;
          const agentId = await startStep(api, await readConfig(), init, phaseDir, story, step, Number(meta.round) || 1, {
            cycle,
            cycles,
            retry: new Date().toISOString(),
          });
          if (!agentId) return { ok: false, error: `${story.id}'s ${STEP_LABELS[step]} is already starting.`, agentId: null };
          return { ok: true, error: null, agentId };
        } catch (cause) {
          return { ok: false, error: cause instanceof Error ? cause.message : String(cause), agentId: null };
        }
      });
    },

    // The story's PR number while that PR is closed, so Retry doesn't reopen a PR block that would
    // block again; null when it's open, merged, unknown or there is none. gh runs outside the chain.
    async closedPr(input: StoryRef): Promise<number | null> {
      const found = await serial(async () => locateStory(input));
      const target = found ? found.story.meta.pr || found.story.meta.branch : "";
      if (!found || !target) return null;
      const pr = await prStatus(found.init.root, target);
      return pr?.state === "closed" ? pr.number : null;
    },

    onTurnEnded(api: PaseoApi, event: { agent: PluginHookAgent; outcome: PluginTurnOutcome; timeline?: readonly unknown[] }) {
      paseo = api;
      // You stopped it: the loop leaves it to you.
      if (event.outcome.kind === "canceled") return Promise.resolve();
      const outcome = event.outcome;
      return serial(async () => {
        const refreshed = (await api.agents.ref(event.agent.id).refresh())?.agent;
        const labels = refreshed?.labels ?? {};
        if (labels.kind !== KIND || !labels["loop-repo"] || !labels["loop-initiative"]) return;
        const init = initiativeAt(labels["loop-repo"], labels["loop-initiative"]);
        const phaseDir = join(init.dir, PHASES_DIR, labels["loop-phase"] ?? "");
        const story = readStoryFiles(phaseDir).find((item) => item.id === labels["loop-story"]);
        if (!story) return;
        if (labels["loop-step"] === "fix") {
          if (outcome.kind === "completed") await finishFix(story);
          return;
        }
        // Only the story's current step (and cycle, or parent) moves it on; an older session talking doesn't.
        if (labels["loop-step"] !== story.meta.step) return;
        if ((labels["loop-cycle"] ?? "") !== (story.meta.cycle ?? "")) return;
        if ((labels["loop-cycles"] ?? "") !== (story.meta.cycles ?? "")) return;
        // The cost cap: a story at or over it blocks before anything new starts. This turn's cost is the
        // agent's live figure, since the context watch may not have written its row yet. A story that is
        // already blocked keeps the block it has, so Retry still knows what to redo.
        if (readCost && story.meta.status !== "pr-open" && story.meta.status !== "blocked") {
          const live = refreshed?.lastUsage?.totalCostUsd;
          const spent = storyCost(
            await readCost.rows(),
            { initiative: labels["loop-initiative"], story: story.id },
            typeof live === "number" ? { agentId: event.agent.id, costUsd: live } : undefined,
          );
          const cap = storyCap(story, await readCost.cap());
          if (spent !== null && cap > 0 && spent >= cap) {
            block(story, `cost cap ($${spent.toFixed(2)} of ${budgetMoney(cap)})`, "cost-cap");
            return;
          }
        }
        // A failed turn is retried by the tick, which gives a rate limit or outage time to clear. One
        // that hit the plan's usage limit waits for the reset instead, and isn't a retry.
        if (outcome.kind === "failed") {
          if (story.meta.agent === event.agent.id && SUPERVISED.has(story.meta.status ?? "")) {
            const resumeAt = usageLimitResumeAt(outcome.error.message, new Date());
            writeFrontmatter(
              story.path,
              resumeAt
                ? { paused_until: resumeAt.toISOString(), stalled: null }
                : { stalled: `Its last turn failed: ${outcome.error.message}` },
            );
          }
          return;
        }
        await reconcile(api, await readConfig(), init, phaseDir, story, true);
        // Still running its step after the turn: the session stopped without its marker.
        const after = readStoryFiles(phaseDir).find((item) => item.id === story.id);
        const state = after?.meta.worktree ? readText(stateFile(after.meta.worktree)) : "";
        if (
          after?.meta.agent === event.agent.id &&
          after.meta.worktree &&
          SUPERVISED.has(after.meta.status ?? "") &&
          SUPERVISED_STEPS.has(after.meta.step ?? "") &&
          readMarker(state).marker === `${after.meta.step}-running`
        ) {
          // This turn's items are those after the last user message.
          const items = (event.timeline ?? []) as readonly ToolItem[];
          const lastUser = items.map((item) => item.type).lastIndexOf("user_message");
          // A parent that ticked a cycle since the last turn end is making progress: its retries start
          // over. One whose turn ended on a subagent call is waiting on it, and that isn't a stall until
          // the wait outlasts SUBAGENT_WAIT_MS (supervise).
          const ticked = readCycles(state).filter((cycle) => cycle.done).length;
          const before = Number(after.meta.ticked_cycles) || 0;
          const lastCall = items.slice(lastUser + 1).filter((item) => item.type === "tool_call").at(-1);
          const waiting = lastCall?.detail?.type === "sub_agent";
          writeFrontmatter(after.path, {
            ...(ticked !== before ? { ticked_cycles: ticked || null } : {}),
            ...(ticked > before ? { retries: null } : {}),
            waiting_subagent_since: waiting ? new Date().toISOString() : null,
          });
          // Claude Code can end the turn normally with the plan limit as its only reply, rather than
          // failing it: that waits for the reset like a failed turn would, and isn't a stall. Only its
          // own notice counts, not a reply that talks about limits. It comes from Claude Code, so the
          // pause is for Claude and gates by provider rather than holding every story.
          const reply = items
            .slice(lastUser + 1)
            .filter((item): item is ToolItem & { text: string } => item.type === "assistant_message" && typeof (item as { text?: unknown }).text === "string")
            .at(-1)?.text;
          const resumeAt = reply ? limitNotice(reply, new Date()) : null;
          if (resumeAt) {
            writeFrontmatter(after.path, { paused_until: resumeAt.toISOString(), paused_for: "claude", stalled: null });
            return;
          }
          let failTests: string[] = [];
          try {
            const parsed: unknown = JSON.parse(after.meta.fail_tests || "[]");
            if (Array.isArray(parsed)) failTests = parsed.filter((name): name is string => typeof name === "string");
          } catch {
            // an unreadable list restarts the streak
          }
          const carried: StuckCounters = {
            idle_turns: Number(after.meta.idle_turns) || 0,
            fail_tests: failTests,
            fail_runs: Number(after.meta.fail_runs) || 0,
          };
          const config = await readConfig();
          const { counters, evidence } = stuckCheck(carried, items.slice(lastUser + 1), {
            step: after.meta.step ?? null,
            subagents: after.meta.cycles === "subagents",
            stuckTurns: config.stuckTurns,
          });
          const progressed = !evidence && after.meta.stuck_nudged;
          writeFrontmatter(after.path, {
            idle_turns: counters.idle_turns || null,
            fail_tests: counters.fail_tests.length ? JSON.stringify(counters.fail_tests) : null,
            fail_runs: counters.fail_runs || null,
            ...(progressed ? { stuck_nudged: null } : {}),
          });
          if (evidence && after.meta.stuck_nudged) {
            block(after, `stuck: ${evidence}`, "stuck");
          } else if (evidence) {
            const why = `You look stuck: ${evidence}.`;
            // Unsent, the session would sit idle with nothing for the tick to act on: stall it instead.
            const sent = await api.agents.ref(event.agent.id).send(nudgePrompt(why)).then(() => true, () => false);
            writeFrontmatter(after.path, sent ? { stuck_nudged: 1 } : { stalled: why });
          } else if (!waiting) {
            writeFrontmatter(after.path, { stalled: "It ended its turn without writing the step's marker." });
          }
        }
        await advance(api, await readConfig(), init);
      });
    },

    // A step session asked for permission: the story blocks until it's answered, so it shows as
    // needing you. It keeps its slot, since its session is still open.
    onPermissionRequested(api: PaseoApi, event: { agent: PluginHookAgent; request: { name: string; title?: string } }) {
      paseo = api;
      return serial(async () => {
        const found = labelledStory((await api.agents.ref(event.agent.id).refresh())?.agent.labels ?? {});
        if (!found || found.story.meta.agent !== event.agent.id || !SUPERVISED.has(found.story.meta.status ?? "")) return;
        block(found.story, `Waiting on permission: ${event.request.title || event.request.name}. Answer it in the session.`, undefined, false);
        writeFrontmatter(found.story.path, { waiting_on: PERMISSION });
      });
    },

    // The permission was answered: the story goes back to the step it was on.
    onPermissionResolved(api: PaseoApi, event: { agent: PluginHookAgent }) {
      paseo = api;
      return serial(async () => {
        const found = labelledStory((await api.agents.ref(event.agent.id).refresh())?.agent.labels ?? {});
        const meta = found?.story.meta;
        if (!found || !meta || meta.waiting_on !== PERMISSION || meta.agent !== event.agent.id) return;
        writeFrontmatter(found.story.path, {
          status: meta.blocked_from || "todo",
          blocked_reason: null,
          blocked_from: null,
          blocked_at: null,
          waiting_on: null,
        });
      });
    },

    tick() {
      const api = paseo;
      if (!api) return Promise.resolve();
      return serial(async () => {
        const config = await readConfig();
        await refreshLimits(api);
        for (const root of readRegistry()) {
          for (const slug of dirsIn(initiativesDir(root))) {
            try {
              const init = initiativeAt(root, slug);
              if (initiativeLoopState(init.dir) === "off" && !hasOpenPr(init)) continue;
              await sweep(api, config, init);
            } catch (error) {
              console.warn("orchestrator: initiative loop tick", root, slug, error);
            }
          }
        }
      });
    },
  };
}

// A stopped initiative still records merges and CI for PRs it opened.
function hasOpenPr(init: Initiative) {
  return phaseDirs(init).some((dir) => readStoryFiles(dir).some((story) => story.meta.status === "pr-open"));
}
