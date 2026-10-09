import { join } from "node:path";
import type { Thresholds } from "../shared/context-meter";
import type { StoryContext } from "../shared/context";
import { contextPanel } from "../shared/context-panel";
import { storyHistory, type TelemetryRow } from "./context-telemetry";
import type { LiveSession } from "./context-watch";
import { dirsIn, PHASES_DIR, readStoryFiles } from "./harness-layout";
import { initiativeAt } from "./initiative-loop";

// The story context panel's server side (see CONTEXT.md, "Story context"). Deps come in so tests
// use a temp .harness and fakes.

export type StoryContextDeps = {
  live: (agentId: string) => Promise<LiveSession | null>;
  rows: () => Promise<TelemetryRow[]>;
  thresholds: () => Promise<Thresholds>;
};

export type StoryContextInput = { repo: string; initiative: string; storyId: string };

// The story's current agent: `agent:` in its file, found across the initiative's phases (story
// ids are unique per initiative). Throws for a bad initiative; null with no such story or agent.
function storyAgent({ repo, initiative, storyId }: StoryContextInput): string | null {
  const { dir } = initiativeAt(repo, initiative);
  for (const phase of dirsIn(join(dir, PHASES_DIR))) {
    const story = readStoryFiles(join(dir, PHASES_DIR, phase)).find((file) => file.id === storyId);
    if (story) return story.meta.agent || null;
  }
  return null;
}

export async function loadStoryContext(input: StoryContextInput, deps: StoryContextDeps): Promise<StoryContext | null> {
  const agentId = storyAgent(input);
  if (!agentId) return null;
  const session = await deps.live(agentId);
  if (!session) return null;
  const step = session.labels["loop-step"] ?? null;
  const rawCycle = session.labels["loop-cycle"];
  const history = storyHistory(await deps.rows(), {
    initiative: input.initiative,
    story: input.storyId,
    agentId,
    step,
    cycle: rawCycle !== undefined && /^\d+$/.test(rawCycle) ? Number(rawCycle) : null,
  });
  const panel = contextPanel({
    reading: session.reading,
    turns: history.turns,
    thresholds: await deps.thresholds(),
    strategy: session.reading.strategy,
    split: session.split,
  });
  return {
    agentId,
    step,
    used: panel.used,
    max: panel.max,
    percent: panel.percent,
    level: panel.level,
    session: history.session,
    compactions: history.compactions,
    burn: panel.burn,
    turnsToAct: panel.turnsToAct,
    markers: panel.markers,
    split: panel.split,
  };
}
