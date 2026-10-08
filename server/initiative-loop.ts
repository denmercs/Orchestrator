import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { PluginHandlerContext, PluginHookAgent, PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { AgentCreateConfig } from "../shared/agent-runner";
import { LOOP_AGENT_KIND, type LoopConfig } from "../shared/initiative-loop";
import { phaseLabel } from "../shared/orchestration";
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
import { failureReport, prForBranch, prStatus } from "./pr-checks";
import {
  MARKERS,
  STEP_LABELS,
  afterImplement,
  implementCommitMessage,
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
import { commitStory, openStoryPr, pushStoryFix } from "./story-git";

// The initiative loop, driven by Paseo events rather than a long-running process:
//   Start            marks the initiative loop: on and starts every ready story of its active phase.
//   agent.turn_ended reads the step's marker in the story worktree's .harness/state.md and starts the
//                    next step in a fresh agent: Plan → Implement (one agent per cycle, committed by the
//                    plugin) → Review → the plugin pushes and opens the PR itself.
//   the 2-minute tick watches each open PR: a failing check starts a Fix CI agent, a merge marks the
//                    story merged, archives its workspace and starts the next ready story.
// The story files are the state: the loop writes status, branch, workspace, agent, pr and ci into
// their frontmatter, so it resumes from them after a restart. Paseo owns the worktrees and agents.

type PaseoApi = PluginHandlerContext["paseo"];
type StoryFile = ReturnType<typeof readStoryFiles>[number];
type Initiative = { root: string; slug: string; dir: string };

const KIND = LOOP_AGENT_KIND;
// Marks loop workspaces and sessions, like 📐 marks architecture sessions.
const MARK = "🔁";
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
// Repos with an initiative that has been started, so the tick knows where to look.
const REGISTRY = join(homedir(), ".orchestrator", "initiative-loops.json");
const ACTIVE = new Set(["planning", "awaiting-approval", "implementing", "reviewing", "pr-open"]);
const STATUS_FOR: Record<LoopStep, string> = {
  plan: "planning",
  implement: "implementing",
  review: "reviewing",
  pr: "reviewing",
  fix: "pr-open",
};

const execFileAsync = promisify(execFile);

// Ends a loop agent's prompt when a fresh compact restarts its step in a new session.
export const RESUME_LINE = "Resume from `.harness/state.md`. An earlier session for this step ran out of context.";

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

function initiativeAt(repo: string, slug: string): Initiative {
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
    ticketUrl: null,
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

function block(story: StoryFile, reason: string) {
  writeFrontmatter(story.path, {
    status: "blocked",
    blocked_reason: reason,
    blocked_from: story.meta.status ?? "todo",
  });
}

export function createInitiativeLoop(
  readConfig: () => Promise<LoopConfig>,
  readAgentConfig: (api: PaseoApi) => Promise<AgentCreateConfig>,
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

  async function startStep(
    api: PaseoApi,
    config: LoopConfig,
    init: Initiative,
    phaseDir: string,
    story: StoryFile,
    step: LoopStep,
    round: number,
    extra: { failing?: string; cycle?: Cycle } = {},
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
      const config = await readAgentConfig(api);
      // Story steps work from the story file and the worktree; none of them needs an MCP server.
      const agent = await withMcpScope(worktree, "none", () =>
        api.workspaces.ref(workspace).agents.create({
          title: `${MARK} ${story.id} · ${label} — ${ctx.title}`.slice(0, 60),
          config,
          prompt: stepPrompt(step, ctx, {
            round,
            failing: extra.failing,
            cycle: extra.cycle,
            plan: readSection(state, "Plan"),
          }),
          labels,
        }),
      );
      writeFrontmatter(story.path, {
        status: STATUS_FOR[step],
        ...(step === "fix" ? {} : { step, round, cycle: extra.cycle?.number ?? null }),
        agent: agent.id,
        blocked_reason: null,
        blocked_from: null,
      });
      return agent.id;
    } catch (error) {
      started.delete(key);
      throw error;
    }
  }

  // Creates (or reuses) the story's worktree workspace and starts its Plan agent.
  async function startStory(api: PaseoApi, config: LoopConfig, init: Initiative, phaseDir: string, story: StoryFile) {
    const base = story.meta.base || (await baseBranch(init));
    const phase = phaseMeta(phaseDir).phase ?? "";
    const branch = story.meta.branch || `feature/${slugOf(`${phase}-${story.id}-${story.meta.title ?? ""}`)}`;
    const title = `${MARK} ${story.id} — ${story.meta.title || story.id}`.slice(0, 60);

    let workspaceId = story.meta.workspace || "";
    let worktree = story.meta.worktree || "";
    const reusable = workspaceId ? await api.workspaces.ref(workspaceId).refresh().catch(() => null) : null;
    if (!reusable || !worktree || !existsSync(worktree)) {
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
    return startStep(api, config, init, phaseDir, fresh, "plan", 1);
  }

  // Moves an in-flight story to its next step from the marker its current step wrote.
  async function reconcile(api: PaseoApi, config: LoopConfig, init: Initiative, phaseDir: string, story: StoryFile, turnEnded: boolean) {
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

    if (step === "plan") {
      if (marker === MARKERS.planDone) await next("implement", 1, readCycles(state).find((cycle) => !cycle.done));
      // The planner ended its turn without approval: it is asking you.
      else if (turnEnded && meta.status === "planning") writeFrontmatter(story.path, { status: "awaiting-approval" });
    } else if (step === "implement") {
      if (marker === MARKERS.implementDone) {
        const finished = meta.cycle ? Number(meta.cycle) : null;
        const after = afterImplement(state, finished);
        if (after.kind === "blocked") {
          block(story, after.reason);
          return;
        }
        const cycle = finished === null ? null : (readCycles(state).find((item) => item.number === finished) ?? null);
        await commitStory(meta.worktree, implementCommitMessage(story.id, cycle, round));
        if (after.kind === "cycle") await next("implement", round, after.cycle);
        else await next("review", round);
      } else if (marker === MARKERS.implementBlocked) block(story, detail || "Implement is blocked; open its session.");
    } else if (step === "review") {
      if (marker === MARKERS.reviewDone && on) await openPr(init, phaseDir, story);
      else if (marker === MARKERS.reviewFailed) {
        if (round >= config.reviewRounds) block(story, `Review failed ${round} times; see ## Review findings in the worktree.`);
        else await next("implement", round + 1);
      }
    } else if (step === "pr" && marker === MARKERS.prDone) {
      const pr = await prForBranch(meta.worktree, meta.branch ?? "");
      if (pr) writeFrontmatter(story.path, { status: "pr-open", pr: pr.number, ci: "pending" });
      else if (turnEnded) block(story, `Open PR finished but there is no open PR for ${meta.branch}.`);
    }
  }

  // Review passed: the plugin commits leftovers, pushes and opens the PR. No agent is needed for this.
  async function openPr(init: Initiative, phaseDir: string, story: StoryFile) {
    const { meta } = story;
    if (!meta.worktree) return;
    const ctx = storyContext(init, phaseDir, story);
    try {
      const pr = await openStoryPr(meta.worktree, { id: story.id, title: ctx.title, branch: meta.branch ?? "", base: ctx.base });
      writeFileSync(stateFile(meta.worktree), writeMarker(readText(stateFile(meta.worktree)), `${MARKERS.prDone}\n${pr.url}`), "utf8");
      writeFrontmatter(story.path, { status: "pr-open", step: "pr", round: 1, cycle: null, agent: null, pr: pr.number, ci: "pending" });
    } catch (error) {
      block(story, `Could not open the PR: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // A Fix CI agent finished: commit and push its change so CI runs again.
  async function finishFix(story: StoryFile) {
    const { meta } = story;
    if (!meta.worktree || meta.status !== "pr-open") return;
    if (readMarker(readText(stateFile(meta.worktree))).marker !== MARKERS.fixDone) return;
    try {
      await pushStoryFix(meta.worktree, `${story.id}: Fix CI`);
    } catch (error) {
      block(story, `Could not push the CI fix: ${error instanceof Error ? error.message : String(error)}`);
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
      block(story, `PR #${pr.number} was closed without merging.`);
      return;
    }
    const ci = pr.state === "failing" ? "failing" : pr.state === "green" ? "green" : pr.state === "no-checks" ? "none" : "pending";
    if (meta.ci !== ci) writeFrontmatter(story.path, { ci });
    if (pr.state !== "failing" || meta.fixed_sha === pr.headSha || initiativeLoopState(init.dir) !== "on") return;
    const fixes = Number(meta.fix_attempts) || 0;
    if (fixes >= config.maxFixes) {
      block(story, `CI still failing after ${fixes} fix attempts: ${pr.failing.map((check) => check.name).join(", ")}`);
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
    const inFlight = stories.filter((story) => ACTIVE.has(story.meta.status ?? "")).length;
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
        block(story, `Could not start: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const running = inFlight + startedNow.length;
    const label = phaseLabel(phaseMeta(phaseDir).phase ?? "");
    return {
      started: startedNow,
      reason: running > 0 ? `${label}: ${running} ${running === 1 ? "story" : "stories"} in flight` : `${label}: nothing ready (blocked or waiting on dependencies)`,
    };
  }

  // Everything the loop does for one initiative on a tick: PRs, in-flight steps, then free slots.
  async function sweep(api: PaseoApi, config: LoopConfig, init: Initiative) {
    for (const phaseDir of phaseDirs(init)) {
      for (const story of readStoryFiles(phaseDir)) {
        try {
          if (story.meta.status === "pr-open") await watchPr(api, config, init, phaseDir, story);
          else if (initiativeLoopState(init.dir) === "on") await reconcile(api, config, init, phaseDir, story, false);
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
      const prompt = stepPrompt(step, ctx, {
        round: Number(labels["loop-round"]) || 1,
        cycle,
        plan: readSection(state, "Plan"),
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

    onTurnEnded(api: PaseoApi, event: { agent: PluginHookAgent; outcome: PluginTurnOutcome }) {
      paseo = api;
      if (event.outcome.kind !== "completed") return Promise.resolve();
      return serial(async () => {
        const labels = (await api.agents.ref(event.agent.id).refresh())?.agent.labels ?? {};
        if (labels.kind !== KIND || !labels["loop-repo"] || !labels["loop-initiative"]) return;
        const init = initiativeAt(labels["loop-repo"], labels["loop-initiative"]);
        const phaseDir = join(init.dir, PHASES_DIR, labels["loop-phase"] ?? "");
        const story = readStoryFiles(phaseDir).find((item) => item.id === labels["loop-story"]);
        if (!story) return;
        if (labels["loop-step"] === "fix") {
          await finishFix(story);
          return;
        }
        // Only the story's current step (and cycle) moves it on; an older session talking doesn't.
        if (labels["loop-step"] !== story.meta.step) return;
        if ((labels["loop-cycle"] ?? "") !== (story.meta.cycle ?? "")) return;
        await reconcile(api, await readConfig(), init, phaseDir, story, true);
        await advance(api, await readConfig(), init);
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
