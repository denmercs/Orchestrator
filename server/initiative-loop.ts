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
import { DEFAULT_PHASES, stepSkills, type Phase, type SkillSource } from "../shared/pipeline";
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
import { failureReport, prForBranch, prStatus } from "./pr-checks";
import { missingPaths, planPaths } from "./plan-paths";
import {
  MARKERS,
  STEP_LABELS,
  afterImplement,
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
import { commitStory, openStoryPr, pushStoryFix, uniqueBranch } from "./story-git";

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
//                    A permission request blocks the story until it's answered.
//                    A turn you cancel is left alone.
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

// `kind` names what blocked it, so the loop can tell its own give-up from the rest and Retry knows what
// to redo: `start` and `pr` and `ci` need no agent, `retry-limit` and `step` do. A permission wait has none.
export type BlockKind = "start" | "pr" | "ci" | "retry-limit" | "step";
function block(story: StoryFile, reason: string, kind?: BlockKind) {
  writeFrontmatter(story.path, {
    status: "blocked",
    blocked_reason: reason,
    blocked_from: story.meta.status ?? "todo",
    block_kind: kind ?? null,
  });
}

export function createInitiativeLoop(
  readConfig: () => Promise<LoopConfig>,
  readAgentConfig: (api: PaseoApi, step: LoopStep, loop: LoopConfig) => Promise<AgentCreateConfig>,
  // The drawer's phases and skill sources: each step loads its phase's extras.
  readPipeline: () => Promise<{ phases: Phase[]; sources: SkillSource[] }>,
  // The branch prefix (`dm`), or null for none.
  readInitials: () => Promise<string | null> = async () => null,
) {
  let paseo: PaseoApi | null = null;
  // Steps started by this process, so a repeated event can't start one twice before its label shows.
  const started = new Set<string>();
  // One loop action at a time: Start, turn ends and the tick all read and write the same story files.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };

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
        block_kind: null,
        stalled: null,
        waiting_on: null,
        ...(extra.attempt ? {} : { retries: null }),
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
      if (marker === MARKERS.reviewDone && on) await openPr(init, phaseDir, story);
      else if (marker === MARKERS.reviewFailed) {
        if (round >= config.reviewRounds) block(story, `Review failed ${round} times; see ## Review findings in the worktree.`, "step");
        else await next("implement", round + 1);
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
      retries: null,
      stalled: null,
      block_kind: null,
    });
    return readStoryFiles(phaseDir).find((item) => item.id === story.id) ?? story;
  }

  // Review passed: the plugin commits leftovers, pushes and opens the PR. No agent is needed for this.
  async function openPr(init: Initiative, phaseDir: string, story: StoryFile) {
    const { meta } = story;
    if (!meta.worktree) return;
    const ctx = storyContext(init, phaseDir, story);
    try {
      const pr = await openStoryPr(meta.worktree, { id: story.id, title: ctx.title, jira: false, branch: meta.branch ?? "", base: ctx.base });
      writeFileSync(stateFile(meta.worktree), writeMarker(readText(stateFile(meta.worktree)), `${MARKERS.prDone}\n${pr.url}`), "utf8");
      writeFrontmatter(story.path, { status: "pr-open", step: "pr", round: 1, cycle: null, agent: null, pr: pr.number, ci: "pending" });
    } catch (error) {
      block(story, `Could not open the PR: ${error instanceof Error ? error.message : String(error)}`, "pr");
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
      block(story, `Could not push the CI fix: ${error instanceof Error ? error.message : String(error)}`, "ci");
    }
  }

  // An open story PR: record merges and CI, and start a Fix CI agent for a new failure.
  async function watchPr(api: PaseoApi, config: LoopConfig, init: Initiative, phaseDir: string, story: StoryFile) {
    const { meta } = story;
    const cwd = meta.worktree && existsSync(meta.worktree) ? meta.worktree : init.root;
    const pr = await prStatus(cwd, meta.pr || meta.branch || "");
    if (!pr) return;
    if (pr.state === "merged") {
      writeFrontmatter(story.path, { status: "merged", ci: null, agent: null });
      if (meta.workspace) await api.workspaces.archive(meta.workspace).catch(() => undefined);
      refreshInitiativeIndex(init.dir);
      return;
    }
    if (pr.state === "closed") {
      block(story, `PR #${pr.number} was closed without merging.`, "pr");
      return;
    }
    const ci = pr.state === "failing" ? "failing" : pr.state === "green" ? "green" : pr.state === "no-checks" ? "none" : "pending";
    if (meta.ci !== ci) writeFrontmatter(story.path, { ci });
    if (pr.state !== "failing" || meta.fixed_sha === pr.headSha || initiativeLoopState(init.dir) !== "on") return;
    const fixes = Number(meta.fix_attempts) || 0;
    if (fixes >= config.maxFixes) {
      block(story, `CI still failing after ${fixes} fix attempts: ${pr.failing.map((check) => check.name).join(", ")}`, "ci");
      return;
    }
    writeFrontmatter(story.path, { fixed_sha: pr.headSha, fix_attempts: fixes + 1 });
    const fresh = readStoryFiles(phaseDir).find((item) => item.id === story.id) ?? story;
    await startStep(api, config, init, phaseDir, fresh, "fix", fixes + 1, { failing: await failureReport(cwd, pr.failing) });
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
    const merged = new Set(phaseDirs(init).flatMap((dir) => readStoryFiles(dir).filter(isMerged).map((story) => story.id)));
    const stories = readStoryFiles(phaseDir);
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
    for (const story of ready.slice(0, Math.max(0, config.parallel - inFlight))) {
      try {
        const agentId = await startStory(api, config, init, phaseDir, story);
        if (agentId) startedNow.push({ story: story.id, agentId });
      } catch (error) {
        block(story, `Could not start: ${error instanceof Error ? error.message : String(error)}`, "start");
      }
    }
    const running = inFlight + startedNow.length;
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
    const session = await api.agents
      .ref(meta.agent)
      .refresh()
      .then((found) => found?.agent ?? null, () => undefined);
    // Paseo didn't answer: that says nothing about the session, so try again next tick.
    if (session === undefined) return;
    if (session?.status === "running" || session?.status === "initializing") return;
    const dead = !session || Boolean(session.archivedAt) || session.status === "closed" || session.status === "error";
    if (!dead && !meta.stalled) return;
    const why = dead
      ? session?.lastError
        ? `Its session failed: ${session.lastError}.`
        : "Its session is gone."
      : meta.stalled ?? "";
    const retries = Number(meta.retries) || 0;
    if (retries >= config.maxRetries) {
      block(story, `${STEP_LABELS[step]}: ${why} Gave up after ${retries} ${retries === 1 ? "retry" : "retries"}.`, "retry-limit");
      return;
    }
    writeFrontmatter(story.path, { retries: retries + 1, stalled: null });
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

  // Everything the loop does for one initiative on a tick: PRs, in-flight steps, then free slots.
  async function sweep(api: PaseoApi, config: LoopConfig, init: Initiative) {
    for (const phaseDir of phaseDirs(init)) {
      for (const story of readStoryFiles(phaseDir)) {
        try {
          if (story.meta.status === "pr-open") await watchPr(api, config, init, phaseDir, story);
          else if (initiativeLoopState(init.dir) === "on") {
            await reconcile(api, config, init, phaseDir, story, false);
            const fresh = readStoryFiles(phaseDir).find((item) => item.id === story.id);
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
          block_kind: null,
          waiting_on: null,
          stalled: null,
          retries: null,
          ...(kind === "ci" ? { fix_attempts: null, fixed_sha: null } : {}),
        });
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

    onTurnEnded(api: PaseoApi, event: { agent: PluginHookAgent; outcome: PluginTurnOutcome }) {
      paseo = api;
      // You stopped it: the loop leaves it to you.
      if (event.outcome.kind === "canceled") return Promise.resolve();
      const outcome = event.outcome;
      return serial(async () => {
        const labels = (await api.agents.ref(event.agent.id).refresh())?.agent.labels ?? {};
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
        // A failed turn is retried by the tick, which gives a rate limit or outage time to clear.
        if (outcome.kind === "failed") {
          if (story.meta.agent === event.agent.id && SUPERVISED.has(story.meta.status ?? "")) {
            writeFrontmatter(story.path, { stalled: `Its last turn failed: ${outcome.error.message}` });
          }
          return;
        }
        await reconcile(api, await readConfig(), init, phaseDir, story, true);
        // Still running its step after the turn: the session stopped without its marker.
        const after = readStoryFiles(phaseDir).find((item) => item.id === story.id);
        if (
          after?.meta.agent === event.agent.id &&
          after.meta.worktree &&
          SUPERVISED.has(after.meta.status ?? "") &&
          SUPERVISED_STEPS.has(after.meta.step ?? "") &&
          readMarker(readText(stateFile(after.meta.worktree))).marker === `${after.meta.step}-running`
        ) {
          writeFrontmatter(after.path, { stalled: "It ended its turn without writing the step's marker." });
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
        block(found.story, `Waiting on permission: ${event.request.title || event.request.name}. Answer it in the session.`);
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
          waiting_on: null,
        });
      });
    },

    tick() {
      const api = paseo;
      if (!api) return Promise.resolve();
      return serial(async () => {
        const config = await readConfig();
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
