import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginHandlerContext, PluginHookAgent, PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { AgentCreateConfig } from "../shared/agent-runner";
import {
  BELT_LABEL,
  PHASE_IDS,
  beltStory,
  phasePrompt,
  phaseSkills,
  phaseTitle,
  type BeltConfig,
  type Phase,
  type SkillRef,
  type Ticket,
} from "../shared/belt";
import {
  MARKERS,
  afterImplement,
  implementCommitMessage,
  readCycles,
  readMarker,
  readSection,
  seedState,
  writeMarker,
  type Cycle,
} from "../shared/story-method";
import type { MergedPr } from "./github-prs";
import type { McpScope } from "./host-mcp";
import { closeIssue } from "./jira";
import { withMcpScope } from "./mcp-scope";
import { installSkills } from "./skill-sources";
import { commitStory, currentBranch, openStoryPr } from "./story-git";

type PaseoApi = PluginHandlerContext["paseo"];
type Labels = Record<string, string>;
type ReadConfig = () => Promise<BeltConfig | null>;
type ReadAgentConfig = (paseo: PaseoApi) => Promise<AgentCreateConfig>;

// Jira Start on a story card branches the worktree off origin/main (client/start-jira-session.ts).
const BASE = "origin/main";
// Plan and Review read the Jira ticket; Implement works from ## Plan and needs no MCP server.
const SCOPE: Record<Phase["id"], McpScope> = { plan: "jira", implement: "none", review: "jira", done: "none" };

// Phases already started by this process, so a repeated event can't start one twice.
const started = new Set<string>();
// The newest belt agent in each worktree. Only it moves the story on, so an older cycle's session
// that you reply to later can't advance the story a second time. Empty after a restart.
const latest = new Map<string, string>();

const stateFile = (cwd: string) => join(cwd, ".harness", "state.md");
const readState = (cwd: string) => (existsSync(stateFile(cwd)) ? readFileSync(stateFile(cwd), "utf8") : "");

function setMarker(cwd: string, marker: string) {
  writeFileSync(stateFile(cwd), writeMarker(readState(cwd), marker), "utf8");
}

function ticketOf(labels: Labels): Ticket {
  return { key: labels.jira ?? "", title: labels["jira-title"] ?? "", url: labels["jira-url"] || null };
}

export async function startStory(
  paseo: PaseoApi,
  config: BeltConfig,
  input: { workspaceId: string; key: string; title: string; url: string | null },
  agentConfig: AgentCreateConfig,
) {
  const plan = config.phases.find((p) => p.id === "plan");
  if (!plan) {
    throw new Error("The belt has no Plan phase.");
  }
  const workspace = paseo.workspaces.ref(input.workspaceId);
  const cwd = workspace.directory ?? (await workspace.refresh())?.workspaceDirectory ?? null;
  const ticket: Ticket = { key: input.key, title: input.title, url: input.url };
  if (cwd && !existsSync(stateFile(cwd))) {
    mkdirSync(join(cwd, ".harness"), { recursive: true });
    writeFileSync(stateFile(cwd), seedState(beltStory(ticket, "", BASE)), "utf8");
  }
  const labels: Labels = {
    jira: input.key,
    kind: "session",
    belt: BELT_LABEL,
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

export async function advanceBelt(
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
  if (labels.belt !== BELT_LABEL || !labels.jira || !PHASE_IDS.includes(phaseId as Phase["id"])) {
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
    await commitStory(cwd, implementCommitMessage(ticket.key, cycle, round));
    if (after.kind === "cycle") await start(phase("implement"), round, after.cycle);
    else await start(phase("review"), round);
  } else if (phaseId === "review" && marker === MARKERS.reviewDone) {
    await openPr(cwd, ticket);
  } else if (phaseId === "review" && marker === MARKERS.reviewFailed) {
    // Findings go back to a fresh Implement agent, up to the round limit; then wait for a human.
    if (round < config.reviewRounds) await start(phase("implement"), round + 1);
  }
}

// Review passed: Done is plain code. Commit leftovers, push, open the PR, then wait for the merge.
async function openPr(cwd: string, ticket: Ticket) {
  const dedupe = `${cwd}:${ticket.key}:pr`;
  if (started.has(dedupe)) {
    return;
  }
  started.add(dedupe);
  try {
    const branch = await currentBranch(cwd);
    const pr = await openStoryPr(cwd, { id: ticket.key, title: ticket.title, branch, base: BASE });
    setMarker(cwd, `${MARKERS.prDone}\n${pr.url}`);
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
  const agents = await listBeltAgents(paseo);
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
  config: BeltConfig,
  phase: Phase,
  ticket: Ticket,
  baseLabels: Labels,
  target: { workspaceId: string | null; cwd: string | null; agentConfig: AgentCreateConfig },
  step: { cycle?: Cycle; plan?: string } = {},
) {
  const round = baseLabels.round ?? "1";
  const labels: Labels = { ...baseLabels, kind: "session", phase: phase.id, round };
  const dedupe = `${target.workspaceId ?? target.cwd}:${ticket.key}:${phase.id}:${round}:${labels.cycle ?? ""}`;
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
      setMarker(cwd, `${phase.id}-running`);
    }
    const branch = cwd ? await currentBranch(cwd).catch(() => "") : "";
    const base = step.cycle ? `${phase.label} ${step.cycle.number}` : phase.label;
    const label = Number(round) > 1 ? `${base} r${round}` : base;
    const options = {
      title: phaseTitle(ticket.key, ticket.title, label),
      config: target.agentConfig,
      prompt: phasePrompt(phase, ticket, { round: Number(round), cycle: step.cycle, plan: step.plan, branch, base: BASE }),
      labels,
    };
    const agent = await withMcpScope(cwd, SCOPE[phase.id], () =>
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
      console.warn("orchestrator:", ticket.key, phase.id, warning);
    }
    return { agent, warnings };
  } catch (error) {
    started.delete(dedupe);
    throw error;
  }
}

async function listBeltAgents(paseo: PaseoApi) {
  const listed = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200 } });
  return listed.entries.map((entry) => entry.agent).filter((agent) => agent.labels?.belt === BELT_LABEL);
}

async function phaseAgentExists(paseo: PaseoApi, labels: Labels, workspaceId: string | null) {
  const agents = await listBeltAgents(paseo);
  return agents.some(
    (agent) =>
      agent.labels?.jira === labels.jira &&
      agent.labels?.phase === labels.phase &&
      (agent.labels?.round ?? "1") === labels.round &&
      (agent.labels?.cycle ?? "") === (labels.cycle ?? "") &&
      (workspaceId === null || agent.workspaceId === workspaceId),
  );
}
