import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginHandlerContext, PluginHookAgent, PluginTurnOutcome } from "@getpaseo/plugin/server";
import {
  BELT_AGENT_CONFIG,
  BELT_LABEL,
  PHASE_IDS,
  closePrompt,
  doneMarker,
  nextPhase,
  phasePrompt,
  phaseSkills,
  phaseTitle,
  readStatus,
  STORY_FILE_LABEL,
  STORY_TRACKER_LABEL,
  type BeltConfig,
  type Phase,
  type Ticket,
} from "../shared/belt";
import type { MergedPr } from "./github-prs";
import { writeFrontmatter } from "./harness-layout";
import { installSkills } from "./skill-sources";

type PaseoApi = PluginHandlerContext["paseo"];
type Labels = Record<string, string>;
type ReadConfig = () => Promise<BeltConfig | null>;

// An initiative story's status while each belt phase runs; merged is set when its PR merges.
const STORY_STATUS: Record<string, string> = {
  plan: "planning",
  implement: "implementing",
  review: "reviewing",
  done: "pr-open",
};

// Phases already started by this process, so a repeated event can't start one twice.
const started = new Set<string>();

export async function startStory(
  paseo: PaseoApi,
  config: BeltConfig,
  input: {
    workspaceId: string;
    key: string;
    title: string;
    url: string | null;
    // An initiative story: its file, and whether its initiative publishes to Jira.
    story?: { file: string; tracker: "local" | "jira" };
  },
) {
  const plan = config.phases[0];
  if (!plan) {
    throw new Error("The belt has no phases.");
  }
  const workspace = paseo.workspaces.ref(input.workspaceId);
  const cwd = workspace.directory ?? (await workspace.refresh())?.workspaceDirectory ?? null;
  const ticket: Ticket = { key: input.key, title: input.title, url: input.url, story: input.story?.file };
  const labels: Labels = {
    jira: input.key,
    kind: "session",
    belt: BELT_LABEL,
    "jira-title": input.title.slice(0, 200),
    "jira-url": input.url ?? "",
    ...(input.story ? { [STORY_FILE_LABEL]: input.story.file, [STORY_TRACKER_LABEL]: input.story.tracker } : {}),
  };
  const result = await startPhase(paseo, config, plan, ticket, labels, {
    workspaceId: input.workspaceId,
    cwd,
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
  if (!config) {
    return;
  }
  const current = config.phases.find((p) => p.id === phaseId);
  if (!current) {
    return;
  }

  const status = await readStateStatus(event.agent.cwd);
  const round = Number(labels.round ?? "1") || 1;
  let next: Phase | null = null;
  let nextRound = round;

  if (status === doneMarker(current.id)) {
    if (current.then === "merge") {
      return;
    }
    next = nextPhase(config.phases, current.id);
  } else if (current.id === "review" && status === "review-failed") {
    // Findings go back to a fresh Implement agent, up to the round limit; then wait for a human.
    if (round >= config.reviewRounds) {
      return;
    }
    next = config.phases.find((p) => p.id === "implement") ?? null;
    nextRound = round + 1;
  }
  if (!next) {
    return;
  }
  // Rounds count review passes; later phases start over at 1.
  if (next.id !== "implement" && next.id !== "review") {
    nextRound = 1;
  }

  const ticket: Ticket = {
    key: labels.jira,
    title: labels["jira-title"] ?? "",
    url: labels["jira-url"] || null,
    story: labels[STORY_FILE_LABEL] || undefined,
  };
  const target = { workspaceId: event.agent.workspaceId, cwd: event.agent.cwd };
  await startPhase(paseo, config, next, ticket, { ...labels, round: String(nextRound) }, target).catch(
    (error) => {
      console.warn("orchestrator: unable to start next phase", ticket.key, next?.id, error);
    },
  );
}

// A story PR merged: run the close step once, in the story's workspace.
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
    const story = agents.filter((agent) => agent.labels?.jira === key);
    const anchor = story.find((agent) => agent.labels?.phase === "done") ?? story[0];
    if (!anchor || story.some((agent) => agent.labels?.phase === "close")) {
      continue;
    }
    // Locally tracked initiative stories have no Jira issue to close; server/phase-loop.ts
    // marks their file merged instead.
    if (anchor.labels?.[STORY_FILE_LABEL] && anchor.labels?.[STORY_TRACKER_LABEL] !== "jira") {
      continue;
    }
    const labels: Labels = { ...(anchor.labels ?? {}), phase: "close", round: "1" };
    const ticket: Ticket = { key, title: labels["jira-title"] ?? "", url: labels["jira-url"] || null };
    const dedupe = `${anchor.workspaceId}:${key}:close`;
    if (started.has(dedupe)) {
      continue;
    }
    started.add(dedupe);
    const options = {
      title: phaseTitle(key, ticket.title, "Close"),
      config: BELT_AGENT_CONFIG,
      prompt: closePrompt(ticket),
      labels,
    };
    try {
      if (anchor.workspaceId) {
        await paseo.workspaces.ref(anchor.workspaceId).agents.create(options);
      } else if (anchor.cwd) {
        await paseo.agents.create({ ...options, cwd: anchor.cwd });
      }
    } catch (error) {
      started.delete(dedupe);
      console.warn("orchestrator: unable to close story", key, error);
    }
  }
}

async function startPhase(
  paseo: PaseoApi,
  config: BeltConfig,
  phase: Phase,
  ticket: Ticket,
  baseLabels: Labels,
  target: { workspaceId: string | null; cwd: string | null },
) {
  const round = baseLabels.round ?? "1";
  const labels: Labels = { ...baseLabels, kind: "session", phase: phase.id, round };
  const dedupe = `${target.workspaceId ?? target.cwd}:${ticket.key}:${phase.id}:${round}`;
  // Turn-end events can repeat; an existing agent for this phase and round means nothing to do.
  if (started.has(dedupe) || (await phaseAgentExists(paseo, labels, target.workspaceId))) {
    return null;
  }
  started.add(dedupe);

  try {
    const skills = phaseSkills(phase);
    const warnings = target.cwd
      ? await installSkills(target.cwd, [skills.runs, ...skills.extras], config.sources)
      : ["No worktree folder found; skills from connected repos were not copied."];
    const label = Number(round) > 1 ? `${phase.label} ${round}` : phase.label;
    const options = {
      title: phaseTitle(ticket.key, ticket.title, label),
      config: BELT_AGENT_CONFIG,
      prompt: phasePrompt(config, phase, ticket, Number(round)),
      labels,
    };
    if (ticket.story && STORY_STATUS[phase.id]) {
      writeFrontmatter(ticket.story, { status: STORY_STATUS[phase.id] });
    }
    const agent = target.workspaceId
      ? await paseo.workspaces.ref(target.workspaceId).agents.create(options)
      : target.cwd
        ? await paseo.agents.create({ ...options, cwd: target.cwd })
        : null;
    if (!agent) {
      throw new Error("No workspace or folder to start the phase in.");
    }
    for (const warning of warnings) {
      console.warn("orchestrator:", ticket.key, phase.id, warning);
    }
    return { agent, warnings };
  } catch (error) {
    started.delete(dedupe);
    throw error;
  }
}

async function readStateStatus(cwd: string) {
  const text = await readFile(join(cwd, ".harness", "state.md"), "utf8").catch(() => null);
  return text === null ? null : readStatus(text);
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
      (workspaceId === null || agent.workspaceId === workspaceId),
  );
}
