import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginHandlerContext, PluginHookAgent, PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { AgentCreateConfig } from "../shared/agent-runner";
import {
  DEFAULT_PHASES,
  FIX_CI,
  PIPELINE_LABEL,
  PHASE_IDS,
  fixPrompt,
  pipelineStory,
  phasePrompt,
  phaseSkills,
  phaseTitle,
  type PipelineConfig,
  type Phase,
  type SkillRef,
  type Ticket,
} from "../shared/pipeline";
import {
  MARKERS,
  afterImplement,
  afterReview,
  commitSubject,
  readCycles,
  readMarker,
  readSection,
  seedState,
  writeMarker,
  type Cycle,
} from "../shared/story-method";
import { ciAction, type CiWatch } from "./ci-watch";
import type { MergedPr } from "./github-prs";
import type { McpScope } from "./host-mcp";
import { closeIssue } from "./jira";
import { withMcpScope } from "./mcp-scope";
import { failureReport, prStatus } from "./pr-checks";
import { installSkills } from "./skill-sources";
import { commitStory, currentBranch, openStoryPr, pushStoryFix } from "./story-git";

type PaseoApi = PluginHandlerContext["paseo"];
type Labels = Record<string, string>;
type ReadConfig = () => Promise<PipelineConfig | null>;
type ReadAgentConfig = (paseo: PaseoApi) => Promise<AgentCreateConfig>;
type StepId = Phase["id"] | typeof FIX_CI.id;

// Jira Start on a story card branches the worktree off origin/main (client/start-jira-session.ts).
const BASE = "origin/main";
// Plan and Review read the Jira ticket; Implement works from ## Plan and needs no MCP server.
const SCOPE: Record<StepId, McpScope> = { plan: "jira", implement: "none", review: "jira", done: "none", fix: "none" };

// Phases already started by this process, so a repeated event can't start one twice.
const started = new Set<string>();
// The newest pipeline agent in each worktree. Only it moves the story on, so an older cycle's session
// that you reply to later can't advance the story a second time. Empty after a restart.
const latest = new Map<string, string>();

const stateFile = (cwd: string) => join(cwd, ".harness", "state.md");
const readState = (cwd: string) => (existsSync(stateFile(cwd)) ? readFileSync(stateFile(cwd), "utf8") : "");

function setMarker(cwd: string, marker: string) {
  writeFileSync(stateFile(cwd), writeMarker(readState(cwd), marker), "utf8");
}

// The CI watch of the PR the pipeline opened, beside state.md so it survives a restart. `done` stops
// the watch: the PR merged or closed, or CI was still failing after maxFixes.
type CiRecord = CiWatch & { pr: number; url: string; done?: "merged" | "closed" | "gave-up" };
const ciFile = (cwd: string) => join(cwd, ".harness", "ci.json");

function readCi(cwd: string): CiRecord | null {
  try {
    return JSON.parse(readFileSync(ciFile(cwd), "utf8")) as CiRecord;
  } catch {
    return null;
  }
}

function writeCi(cwd: string, record: CiRecord) {
  writeFileSync(ciFile(cwd), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function ticketOf(labels: Labels): Ticket {
  return { key: labels.jira ?? "", title: labels["jira-title"] ?? "", url: labels["jira-url"] || null };
}

export async function startStory(
  paseo: PaseoApi,
  config: PipelineConfig,
  input: { workspaceId: string; key: string; title: string; url: string | null },
  agentConfig: AgentCreateConfig,
) {
  const plan = config.phases.find((p) => p.id === "plan");
  if (!plan) {
    throw new Error("The pipeline has no Plan phase.");
  }
  const workspace = paseo.workspaces.ref(input.workspaceId);
  const cwd = workspace.directory ?? (await workspace.refresh())?.workspaceDirectory ?? null;
  const ticket: Ticket = { key: input.key, title: input.title, url: input.url };
  if (cwd && !existsSync(stateFile(cwd))) {
    mkdirSync(join(cwd, ".harness"), { recursive: true });
    writeFileSync(stateFile(cwd), seedState(pipelineStory(ticket, "", BASE)), "utf8");
  }
  const labels: Labels = {
    jira: input.key,
    kind: "session",
    pipeline: PIPELINE_LABEL,
    "jira-title": input.title.slice(0, 200),
    "jira-url": input.url ?? "",
  };
  const result = await startPhase(paseo, config, plan, ticket, labels, {
    workspaceId: input.workspaceId,
    cwd,
    agentConfig,
  });
  if (!result) {
    throw new Error(`${input.key} already has a ${plan.label} agent running.`);
  }
  return { agentId: result.agent.id, warnings: result.warnings };
}

export async function advancePipeline(
  paseo: PaseoApi,
  event: { agent: PluginHookAgent; outcome: PluginTurnOutcome },
  readConfig: ReadConfig,
  readAgentConfig: ReadAgentConfig,
) {
  if (event.outcome.kind !== "completed") {
    return;
  }
  const refreshed = await paseo.agents.ref(event.agent.id).refresh();
  const labels: Labels = { ...(refreshed?.agent.labels ?? {}) };
  const phaseId = labels.phase;
  if (labels.pipeline !== PIPELINE_LABEL || !labels.jira || !(PHASE_IDS.includes(phaseId as Phase["id"]) || phaseId === FIX_CI.id)) {
    return;
  }
  const config = await readConfig();
  const cwd = event.agent.cwd;
  if (!config || !cwd || (latest.has(cwd) && latest.get(cwd) !== event.agent.id)) {
    return;
  }
  const phase = (id: Phase["id"]) => config.phases.find((p) => p.id === id) ?? null;
  const state = readState(cwd);
  const { marker } = readMarker(state);
  const round = Number(labels.round ?? "1") || 1;
  const ticket = ticketOf(labels);
  const start = async (next: Phase | null, nextRound: number, cycle?: Cycle) => {
    if (!next) return;
    const nextLabels: Labels = { ...labels, round: String(nextRound) };
    delete nextLabels.cycle;
    if (cycle) nextLabels.cycle = String(cycle.number);
    await startPhase(
      paseo,
      config,
      next,
      ticket,
      nextLabels,
      { workspaceId: event.agent.workspaceId, cwd, agentConfig: await readAgentConfig(paseo) },
      { cycle, plan: readSection(state, "Plan") },
    ).catch((error) => {
      console.warn("orchestrator: unable to start next phase", ticket.key, next.id, error);
    });
  };

  if (phaseId === "plan" && marker === MARKERS.planDone) {
    await start(phase("implement"), 1, readCycles(state).find((cycle) => !cycle.done));
  } else if (phaseId === "implement" && marker === MARKERS.implementDone) {
    const finished = labels.cycle ? Number(labels.cycle) : null;
    const after = afterImplement(state, finished);
    if (after.kind === "blocked") {
      setMarker(cwd, `${MARKERS.implementBlocked}\n${after.reason}`);
      return;
    }
    const cycle = finished === null ? null : (readCycles(state).find((item) => item.number === finished) ?? null);
    const fallback = cycle ? cycle.name : round > 1 ? "Fix review findings" : ticket.title;
    await commitStory(cwd, commitSubject(state, fallback));
    if (after.kind === "cycle") await start(phase("implement"), round, after.cycle);
    else await start(phase("review"), round);
  } else if (phaseId === "review" && (marker === MARKERS.reviewDone || marker === MARKERS.reviewFailed)) {
    // Open findings go back to a fresh Implement agent, up to the round limit; then blocking ones wait for you.
    const after = afterReview(state, marker, round, config.reviewRounds);
    if (after.kind === "fix") await start(phase("implement"), round + 1);
    else if (after.kind === "blocked") setMarker(cwd, `review-blocked\n${after.reason}`);
    else await openPr(cwd, ticket, after.unfixed);
  } else if (phaseId === FIX_CI.id && marker === MARKERS.fixDone) {
    await finishFix(cwd, state);
  }
}

// A Fix CI agent finished: commit and push its change so CI runs again. The tick watches the new head.
async function finishFix(cwd: string, state: string) {
  try {
    await pushStoryFix(cwd, commitSubject(state, "Fix failing CI checks"));
    setMarker(cwd, `${MARKERS.prDone}\n${readCi(cwd)?.url ?? ""}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    setMarker(cwd, `fix-failed\n${reason}`);
    console.warn("orchestrator: unable to push the CI fix", cwd, reason);
  }
}

// The 2-minute tick: the CI watcher checks each PR the pipeline opened. A failing head starts a Fix CI
// agent in the story's worktree; past maxFixes the story stops with `ci-failed` and the reason.
export async function watchPipelinePrs(paseo: PaseoApi, readConfig: ReadConfig, readAgentConfig: ReadAgentConfig) {
  const config = await readConfig();
  if (!config) return;
  const checked = new Set<string>();
  for (const agent of await listPipelineAgents(paseo)) {
    const cwd = agent.cwd;
    if (!cwd || checked.has(cwd) || !agent.labels?.jira) continue;
    checked.add(cwd);
    const record = readCi(cwd);
    if (!record || record.done) continue;
    const pr = await prStatus(cwd, record.pr);
    if (!pr) continue;
    const action = ciAction(pr, record, config.maxFixes);
    if (action.kind === "wait") continue;
    if (action.kind === "fix") {
      writeCi(cwd, { ...record, fixedSha: action.headSha, attempts: action.attempt });
      const labels: Labels = { ...agent.labels, round: String(action.attempt) };
      delete labels.cycle;
      const implement =
        config.phases.find((p) => p.id === "implement") ?? DEFAULT_PHASES.find((p) => p.id === "implement");
      if (!implement) continue;
      await startPhase(
        paseo,
        config,
        implement,
        ticketOf(labels),
        labels,
        { workspaceId: agent.workspaceId ?? null, cwd, agentConfig: await readAgentConfig(paseo) },
        { failing: await failureReport(cwd, pr.failing) },
      ).catch((error) => {
        console.warn("orchestrator: unable to start Fix CI", labels.jira, error);
      });
      continue;
    }
    writeCi(cwd, { ...record, done: action.kind === "give-up" ? "gave-up" : action.kind });
    if (action.kind === "give-up") setMarker(cwd, `ci-failed\n${action.reason}`);
  }
}

// Review passed: Done is plain code. Commit leftovers, push, open the PR, then wait for the merge.
async function openPr(cwd: string, ticket: Ticket, unfixed: string[] = []) {
  const dedupe = `${cwd}:${ticket.key}:pr`;
  if (started.has(dedupe)) {
    return;
  }
  started.add(dedupe);
  try {
    const branch = await currentBranch(cwd);
    const pr = await openStoryPr(cwd, { id: ticket.key, title: ticket.title, jira: true, branch, base: BASE, unfixed });
    setMarker(cwd, `${MARKERS.prDone}\n${pr.url}`);
    if (readCi(cwd)?.pr !== pr.number) writeCi(cwd, { pr: pr.number, url: pr.url, fixedSha: null, attempts: 0 });
  } catch (error) {
    started.delete(dedupe);
    const reason = error instanceof Error ? error.message : String(error);
    setMarker(cwd, `pr-failed\n${reason}`);
    console.warn("orchestrator: unable to open the PR", ticket.key, reason);
  }
}

// A story PR merged: close the Jira story (subtasks first) once, without an agent.
export async function closeMergedStories(paseo: PaseoApi, fresh: MergedPr[], readConfig: ReadConfig) {
  const config = await readConfig();
  if (!config?.closeOnMerge) {
    return;
  }
  const keys = new Set(fresh.map((pr) => pr.key).filter((key): key is string => Boolean(key)));
  if (keys.size === 0) {
    return;
  }
  const agents = await listPipelineAgents(paseo);
  for (const key of keys) {
    const dedupe = `close:${key}`;
    if (started.has(dedupe) || !agents.some((agent) => agent.labels?.jira === key)) {
      continue;
    }
    started.add(dedupe);
    const closed = await closeIssue(key);
    if (!closed.ok) {
      started.delete(dedupe);
      console.warn("orchestrator: unable to close story", key, closed.error);
    }
  }
}

async function startPhase(
  paseo: PaseoApi,
  config: PipelineConfig,
  phase: Phase,
  ticket: Ticket,
  baseLabels: Labels,
  target: { workspaceId: string | null; cwd: string | null; agentConfig: AgentCreateConfig },
  // `failing` makes this a Fix CI agent, with `phase` (Implement) giving it its skills.
  step: { cycle?: Cycle; plan?: string; failing?: string } = {},
) {
  const round = baseLabels.round ?? "1";
  const fix = step.failing !== undefined;
  const id: StepId = fix ? FIX_CI.id : phase.id;
  const labels: Labels = { ...baseLabels, kind: "session", phase: id, round };
  const dedupe = `${target.workspaceId ?? target.cwd}:${ticket.key}:${id}:${round}:${labels.cycle ?? ""}`;
  // Turn-end events can repeat; an existing agent for this phase, round and cycle means nothing to do.
  if (started.has(dedupe) || (await phaseAgentExists(paseo, labels, target.workspaceId))) {
    return null;
  }
  started.add(dedupe);

  try {
    const skills = phaseSkills(phase);
    const refs = [skills.runs, ...skills.extras].filter((ref): ref is SkillRef => ref !== null);
    const warnings = target.cwd
      ? await installSkills(target.cwd, refs, config.sources)
      : ["No worktree folder found; skills from connected repos were not copied."];
    const cwd = target.cwd;
    if (cwd) {
      setMarker(cwd, `${id}-running`);
    }
    const branch = cwd ? await currentBranch(cwd).catch(() => "") : "";
    const base = fix ? FIX_CI.label : step.cycle ? `${phase.label} ${step.cycle.number}` : phase.label;
    const label = Number(round) > 1 ? `${base} r${round}` : base;
    const prompt = fix
      ? fixPrompt(phase, ticket, { round: Number(round), failing: step.failing, branch, base: BASE })
      : phasePrompt(phase, ticket, { round: Number(round), cycle: step.cycle, plan: step.plan, branch, base: BASE });
    const options = {
      title: phaseTitle(ticket.key, ticket.title, label),
      config: target.agentConfig,
      prompt,
      labels,
    };
    const agent = await withMcpScope(cwd, SCOPE[id], () =>
      target.workspaceId
        ? paseo.workspaces.ref(target.workspaceId).agents.create(options)
        : cwd
          ? paseo.agents.create({ ...options, cwd })
          : Promise.resolve(null),
    );
    if (!agent) {
      throw new Error("No workspace or folder to start the phase in.");
    }
    if (cwd) latest.set(cwd, agent.id);
    for (const warning of warnings) {
      console.warn("orchestrator:", ticket.key, id, warning);
    }
    return { agent, warnings };
  } catch (error) {
    started.delete(dedupe);
    throw error;
  }
}

async function listPipelineAgents(paseo: PaseoApi) {
  const listed = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200 } });
  return listed.entries.map((entry) => entry.agent).filter((agent) => agent.labels?.pipeline === PIPELINE_LABEL);
}

async function phaseAgentExists(paseo: PaseoApi, labels: Labels, workspaceId: string | null) {
  const agents = await listPipelineAgents(paseo);
  return agents.some(
    (agent) =>
      agent.labels?.jira === labels.jira &&
      agent.labels?.phase === labels.phase &&
      (agent.labels?.round ?? "1") === labels.round &&
      (agent.labels?.cycle ?? "") === (labels.cycle ?? "") &&
      (workspaceId === null || agent.workspaceId === workspaceId),
  );
}
