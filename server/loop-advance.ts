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
  const parentIds = new Set<string>();

  for (const pr of fresh) {
    const children = agents.filter((agent) => agent.labels?.jira === pr.key && pr.key);
    for (const child of children) {
      const parentId = agentParentId(child.labels);
      if (parentId) {
        parentIds.add(parentId);
      }
    }
  }

  if (parentIds.size === 0) {
    for (const agent of agents) {
      if (agent.labels?.kind === "epic-loop") {
        parentIds.add(agent.id);
      }
    }
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

function agentParentId(labels: Record<string, string> | undefined) {
  const value = labels?.[PARENT_LABEL];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
