import type { PluginHandlerContext, PluginHookAgent, PluginTurnOutcome } from "@getpaseo/plugin/server";
import { PR_POLL_MS } from "../shared/timing";
import { listMergedPrs, type MergedPr } from "./github-prs";

type PaseoApi = PluginHandlerContext["paseo"];

export { PR_POLL_MS };
const PROMPT_COOLDOWN_MS = 90_000;
const PARENT_LABEL = "paseo.parent-agent-id";

type LoopAdvance = {
  rememberPaseo: (paseo: PaseoApi) => void;
  seedMergedPrs: () => Promise<void>;
  onTurnEnded: (event: {
    agent: PluginHookAgent;
    outcome: PluginTurnOutcome;
  }) => Promise<void>;
  pollMergedPrs: () => Promise<void>;
};

export function createLoopAdvance(
  onMerged?: (paseo: PaseoApi, fresh: MergedPr[]) => Promise<void>,
): LoopAdvance {
  const seen = new Set<string>();
  const lastPromptAt = new Map<string, number>();
  let seeded = false;
  let paseo: PaseoApi | null = null;

  async function checkForNewMerges(reason: string) {
    const listing = await listMergedPrs();
    const current = new Set(listing.prs.map(prId));
    if (!seeded) {
      for (const id of current) {
        seen.add(id);
      }
      seeded = true;
      return;
    }

    const fresh = listing.prs.filter((pr) => !seen.has(prId(pr)));
    for (const id of current) {
      seen.add(id);
    }
    if (fresh.length === 0 || !paseo) {
      return;
    }
    if (onMerged) {
      await onMerged(paseo, fresh).catch((error) => {
        console.warn("orchestrator: merge follow-up failed", error);
      });
    }
    await promptParents(paseo, fresh, reason, lastPromptAt);
  }

  return {
    rememberPaseo(next) {
      paseo = next;
    },
    async seedMergedPrs() {
      await checkForNewMerges("seed");
    },
    async onTurnEnded(event) {
      if (event.outcome.kind !== "completed") {
        return;
      }
      await checkForNewMerges(`session ${event.agent.id} finished`);
    },
    async pollMergedPrs() {
      await checkForNewMerges("2m poll");
    },
  };
}

function prId(pr: MergedPr) {
  return pr.url || `${pr.repo}#${pr.number}`;
}

async function promptParents(
  paseo: PaseoApi,
  fresh: MergedPr[],
  reason: string,
  lastPromptAt: Map<string, number>,
) {
  const listed = await paseo.agents.list({
    filter: { includeArchived: false },
    page: { limit: 100 },
  });
  const agents = listed.entries
    .map((entry) => entry.agent)
    .filter((agent) => !agent.archivedAt && agent.status !== "closed");
  const parentIds = parentsForMerges(agents, fresh);
  if (parentIds.size === 0) {
    return;
  }

  const now = Date.now();
  const shipped = fresh
    .map((pr) => (pr.key ? `${pr.key} ${pr.title}`.trim() : `${pr.repo}#${pr.number} ${pr.title}`))
    .join("; ");
  const prompt = [
    "A pull request just merged. Advance this epic loop.",
    "",
    `Merged: ${shipped}`,
    `Signal: ${reason}`,
    "",
    "Check remaining open children in dependency order. Spawn the next ready ticket if one is unblocked. Do not re-implement shipped work. Stop if the epic is done or waiting on a human.",
    "Check children by status only; do not read their transcripts. End your turn when nothing is ready; the plugin wakes you on the next merge.",
  ].join("\n");

  for (const parentId of parentIds) {
    const parent = agents.find((agent) => agent.id === parentId);
    if (!parent || parent.status === "running" || parent.status === "initializing") {
      continue;
    }
    const previous = lastPromptAt.get(parentId) ?? 0;
    if (now - previous < PROMPT_COOLDOWN_MS) {
      continue;
    }
    lastPromptAt.set(parentId, now);
    try {
      await paseo.agents.ref(parentId).send(prompt);
    } catch (error) {
      console.warn("orchestrator: unable to advance loop", parentId, error);
    }
  }
}

type ListedAgent = {
  id: string;
  title?: string | null;
  parentAgentId?: string | null;
  labels?: Readonly<Record<string, string>>;
};

// The epic parents to wake: only the parent of a session working a merged PR's Jira key. A child is
// matched by its jira label or by a title that starts with the key ("KEY — summary"). A merge no
// child session is working wakes nobody; waking every epic parent on any merge replays each
// parent's whole conversation for nothing.
export function parentsForMerges(agents: readonly ListedAgent[], fresh: readonly Pick<MergedPr, "key">[]) {
  const parentIds = new Set<string>();
  for (const pr of fresh) {
    const key = pr.key;
    if (!key) continue;
    for (const agent of agents) {
      if (!worksOn(agent, key)) continue;
      const parentId = agentParentId(agent.labels) ?? agent.parentAgentId ?? null;
      if (parentId && parentId !== agent.id) parentIds.add(parentId);
    }
  }
  return parentIds;
}

function worksOn(agent: ListedAgent, key: string) {
  if (agent.labels?.jira === key) return true;
  const title = (agent.title ?? "").trim();
  return title === key || new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9-])`).test(title);
}

function agentParentId(labels: Readonly<Record<string, string>> | undefined) {
  const value = labels?.[PARENT_LABEL];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
