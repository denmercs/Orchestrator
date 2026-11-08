import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginHandlerContext, PluginHookAgent, PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { LoopConfig } from "../shared/initiative-loop";
import { readMarker } from "../shared/story-method";
import { steerManager } from "./factory-manager";
import { TEST_DONE, TEST_FAILED, block as blockSlice } from "./factory-phases";
import { sliceStory } from "./factory-slice-story";
import { writeFrontmatter } from "./harness-layout";
import { nudgePrompt } from "./initiative-loop";
import { carryStuck, turnItems } from "./stuck-carry";
import { STUCK_CLEAR } from "./story-steps";

type PaseoApi = PluginHandlerContext["paseo"];

export type FactorySeatDeps = {
  readFactoryRoot: () => Promise<string | null>;
  readConfig: () => Promise<LoopConfig>;
  // One line to the factory manager at `root` as a steer. Absent, `steerManager`.
  steer?: (root: string, line: string, paseo: PaseoApi) => Promise<unknown>;
};

const readText = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

// A completed turn of a factory slice's seat (the loop never supervises these stories): the same stuck check as a loop
// step, on the slice's story. It runs for the builder, QA and reviewer seats while the slice is in build, test, review
// or ship, not already stopped, and still working its step (its marker not yet done). The first evidence nudges the seat; evidence again, or a nudge that won't send, blocks
// the slice and steers the manager. Seats started by the tick's own create carry `slice` and `mission` labels, the loop
// steps `factory-slice` and `factory-mission`; the step is the `loop-step` label, none for a seat off the loop's steps.
export async function factorySeatTurnEnded(
  paseo: PaseoApi,
  event: { agent: PluginHookAgent; outcome: PluginTurnOutcome; timeline?: readonly unknown[] },
  deps: FactorySeatDeps,
) {
  if (event.outcome.kind !== "completed") return;
  const refreshed = await paseo.agents.ref(event.agent.id).refresh().catch(() => null);
  const labels = refreshed?.agent.labels ?? {};
  if (labels.kind !== "factory-seat" || !["builder", "qa", "reviewer"].includes(labels.seat ?? "")) return;
  const found = await sliceStory(deps.readFactoryRoot, {
    ...labels,
    "factory-slice": labels["factory-slice"] ?? labels.slice,
    "factory-mission": labels["factory-mission"] ?? labels.mission,
  });
  if (!found || found.slice.state.agent !== event.agent.id || found.slice.state.ready) return;
  if (!["build", "test", "review", "ship"].includes(found.slice.state.phase)) return;
  const { story } = found;
  // Only while the step is still in progress, as the loop path: a turn that wrote its done or verdict marker has
  // finished, and a nudge would wake it in a worktree the next seat is about to use.
  const worktree = found.slice.state.worktree || story.meta.worktree;
  const marker = worktree ? readMarker(readText(join(worktree, ".harness", "state.md"))).marker : null;
  const step = labels["loop-step"];
  if (step ? marker !== `${step}-running` : marker === TEST_DONE || marker === TEST_FAILED) return;
  const evidence = carryStuck(story.path, story.meta, turnItems(event.timeline), {
    step: step ?? null,
    subagents: story.meta.cycles === "subagents",
    stuckTurns: (await deps.readConfig()).stuckTurns,
  });
  if (!evidence) return;
  const why = `You look stuck: ${evidence}.`;
  // A nudge that doesn't send leaves the seat idle with nothing for the tick to act on: block instead.
  if (!story.meta.stuck_nudged && (await paseo.agents.ref(event.agent.id).send(nudgePrompt(why)).then(() => true, () => false))) {
    writeFrontmatter(story.path, { stuck_nudged: 1 });
    return;
  }
  // A reopen starts the counters clean, as a reopened loop story does.
  writeFrontmatter(story.path, STUCK_CLEAR);
  const steer = (line: string) => (deps.steer ?? steerManager)(found.root, line, paseo);
  await blockSlice(found.root, found.slice, { steer }, `stuck: ${evidence}.`);
}
