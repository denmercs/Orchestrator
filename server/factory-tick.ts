import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FactoryPhase, FactorySlice } from "../shared/factory";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { AgentCreateConfig } from "../shared/agent-runner";
import type { Phase, SkillSource } from "../shared/pipeline";
import { branchName } from "../shared/naming";
import type { LoopStep, StoryContext } from "../shared/story-method";
import { type ManagerPaseo, MANAGER_MODELS } from "./factory-manager";
import { factoryDir, factoryTick, readFactory, sliceDir, writeSliceState } from "./factory-layout";
import { REFOCUS, TEST_DONE, TEST_FAILED, leaveBuild, leaveReview, leaveShip, leaveTest } from "./factory-phases";
import { frontmatter, slugOf, writeFrontmatter } from "./harness-layout";
import type { FailingCheck, PrStatus } from "./pr-checks";
import type { OpenedPr } from "./story-git";

// The seat that works each phase. The manager owns `spec`, which the tick doesn't deliver.
const SEATS: Partial<Record<FactoryPhase, string>> = {
  design: "design",
  build: "builder",
  test: "qa",
  review: "reviewer",
  ship: "builder",
};

// The loop statuses whose step session the loop itself still supervises.
const LOOP_STEPS = new Set(["planning", "implementing", "reviewing"]);

// What the tick needs of Paseo; tests pass a fake. The same shape the manager uses, minus the steer.
export type TickPaseo = {
  // A fresh worktree for a slice, branched off `base`; `directory` is its folder. Absent in a handle that can't make one.
  worktrees?: { create(request: { cwd: string; branch: string; base: string; slug: string }): Promise<{ directory: string }> };
  // What `launchStep` needs to run a loop step in a slice's worktree. Absent in a handle that can't: build then falls through to seat supervision.
  steps?: {
    api: PluginHandlerContext["paseo"];
    readPipeline: () => Promise<{ phases: Phase[]; sources: SkillSource[] }>;
    // The runner config for a step: the loop picks a per-step profile, so the step is passed.
    readAgentConfig: (step: LoopStep) => Promise<AgentCreateConfig>;
  };
  // Commits a finished Implement's work (`commitStory` when absent).
  commit?: (cwd: string, message: string) => Promise<boolean>;
  // The ship phase's git and gh, each defaulting to the real one (`openStoryPr`, `prStatus`, `failureReport`, `pushStoryFix`). There is no merge port: the tick never merges.
  openPr?: (cwd: string, input: { id: string; title: string; jira: boolean; branch: string; base: string; subject?: string; unfixed?: string[] }) => Promise<OpenedPr | null>;
  prStatus?: (cwd: string, pr: number | string) => Promise<PrStatus | null>;
  failureReport?: (cwd: string, failing: FailingCheck[]) => Promise<string>;
  push?: (cwd: string, message: string) => Promise<unknown>;
  // One line to the factory manager as a steer (`steerManager` in the real wiring). Absent: the slice still records its state, nothing is sent.
  steer?: (line: string) => Promise<unknown>;
  // A message to a slice agent's session, for the plan gate's approval.
  send?: (agentId: string, text: string) => Promise<unknown>;
  agents: {
    ref(id: string): { refresh(): Promise<{ agent: { status?: string; archivedAt?: string | null } } | null> };
    create(request: Omit<Parameters<ManagerPaseo["agents"]["create"]>[0], "config"> & { prompt: string; config: AgentCreateConfig }): Promise<{ id: string }>;
  };
};

export type TickResult =
  | { kind: "idle" }
  | { kind: "waiting"; slice: string; why: string }
  | { kind: "advanced"; slice: string; phase: FactoryPhase }
  | { kind: "alive"; slice: string; agent: string }
  | { kind: "restarted"; slice: string; agent: string };

const isDead = (session: { status?: string; archivedAt?: string | null } | undefined | null) =>
  !session || Boolean(session.archivedAt) || session.status === "closed" || session.status === "error";

// The QA seat's brief: run the checks the spec names (they're in the spec above), fill proof.md, and give a verdict where the
// loop steps write theirs, the `## Status` of `.harness/state.md` in the worktree. The tick reads the verdict once the turn ends.
const qaLines = () => [
  "Run the checks the spec names, and no others. Write what you ran and what it showed in `proof.md` in the slice folder.",
  `Then set \`## Status\` in \`.harness/state.md\` in the worktree to \`${TEST_DONE}\` when every check passes. If any fails, set it to \`${TEST_FAILED}\` and put one failing check per line below it, with what you saw. Do not fix the code.`,
];

// The prompt a fresh seat agent gets: the shared instructions first (so the provider can cache them), the slice
// projection last. Refocus is the slice spec, the mission outcome, the project intent and one question.
export function seatPrompt(seat: string, slice: FactorySlice, mission: string, project: string, home: string): string {
  return [
    `You are the ${seat} seat of a software factory. The plan is under \`${home}\`; open only your slice's files.`,
    "Do the work for the current phase and stop. If the spec looks wrong, say so in `proof.md` and stop; never edit the spec, `culture.md` or seat notes.",
    "",
    `Slice ${slice.id}, phase ${slice.state.phase}, attempt ${slice.state.attempt}.`,
    `Spec: ${slice.spec}`,
    `Mission outcome: ${mission}`,
    `Project intent: ${project}`,
    ...(seat === "builder" && slice.design ? [`Design: ${slice.design}`] : []),
    ...(seat === "qa" ? qaLines() : []),
    REFOCUS,
  ].join("\n");
}

let running = false;

// One factory pass: finds the one runnable slice and, when its seat's agent is missing, archived, closed or in error,
// starts one fresh agent in the slice's worktree and records its id. A live agent (a permission wait included) is left
// alone, and so is a story whose loop session is still live: one owner per story. Never throws on a missing factory.
export async function runFactoryTick(root: string, ports: TickPaseo): Promise<TickResult> {
  if (running) return { kind: "idle" };
  running = true;
  try {
    return await pass(root, ports);
  } finally {
    running = false;
  }
}

// Moves a slice out of a phase when the files show it is done; null when the phase has no such step or its seat is still at work.
// Phases move only on evidence in the files (plus a finished turn, for the phases a seat works).
async function advanceSlice(root: string, slice: FactorySlice, ports: TickPaseo): Promise<TickResult | null> {
  if (slice.state.phase === "spec") return (await adoptStory(root, slice)) ?? leaveSpec(root, slice, ports);
  if (slice.state.phase === "design") return leaveDesign(root, slice, ports);
  if (slice.state.phase === "build") return leaveBuild(root, slice, ports, buildContext(slice));
  if (slice.state.phase === "test") return leaveTest(root, slice, ports, buildContext(slice));
  if (slice.state.phase === "review") return leaveReview(root, slice, ports, buildContext(slice));
  if (slice.state.phase === "ship") return leaveShip(root, slice, ports, buildContext(slice));
  return null;
}

// `design` is the design seat's: a written design.md plus a finished turn is the evidence. Null while design.md is empty
// or the seat is mid-turn, so the pass falls through to seat supervision (which starts a seat or leaves a live one).
async function leaveDesign(root: string, slice: FactorySlice, ports: TickPaseo): Promise<TickResult | null> {
  const { id, mission, state } = slice;
  if (!slice.design) return null;
  if (state.agent) {
    const status = (await ports.agents.ref(state.agent).refresh())?.agent.status;
    if (status === "running" || status === "initializing") return null;
  }
  writeSliceState(root, mission, id, { phase: "build" });
  return { kind: "advanced", slice: id, phase: "build" };
}

// The story context a slice's loop steps run with. The body is the spec, then the design when the slice has one, so the
// builder's Plan sees both. Build steps (cycle 5) pass this to `launchStep`.
export function buildContext(slice: FactorySlice): StoryContext {
  return {
    id: slice.id,
    title: slice.id,
    body: slice.design ? `${slice.spec}\n\n## Design\n\n${slice.design}` : slice.spec,
    ticketKey: null,
    ticketUrl: null,
    storyFile: slice.state.story || null,
    storiesDir: null,
    phaseLabel: null,
    phaseTitle: null,
    architectureFile: null,
    initiativeTitle: null,
    initiativeFile: null,
    branch: branchName({ title: slice.id }),
    base: "origin/main",
  };
}

// A slice that names a story already in flight skips the spec handoff: the story's step says which phase it is in. Plan,
// diagnose and implement are `build`, review is `review`, an open PR is `ship` (the slice's own `pr` wins over the story's).
// Null when the story is missing or has no step yet, so the normal spec handling runs.
function adoptStory(root: string, slice: FactorySlice): TickResult | null {
  const { id, mission, state } = slice;
  if (!state.story || !existsSync(state.story)) return null;
  const meta = frontmatter(readFileSync(state.story, "utf8"));
  if (!meta.step) return null;
  const phase: FactoryPhase | null =
    meta.status === "pr-open" || meta.step === "pr-open" ? "ship" : meta.step === "review" ? "review" : ["plan", "diagnose", "implement"].includes(meta.step) ? "build" : null;
  if (!phase) return null;
  writeSliceState(root, mission, id, { phase, ...(phase === "ship" && !state.pr && meta.pr ? { pr: meta.pr } : {}) });
  return { kind: "advanced", slice: id, phase };
}

// `spec` is the manager's: a written spec.md is the evidence. The slice gets a worktree and a story file first (each saved
// as it's made, so a failed pass resumes), then goes to design when its state says so, else to build.
async function leaveSpec(root: string, slice: FactorySlice, ports: TickPaseo): Promise<TickResult> {
  const { id, mission, state } = slice;
  if (!slice.spec) return { kind: "waiting", slice: id, why: "its spec is empty" };
  let worktree = state.worktree;
  if (!worktree || !existsSync(worktree)) {
    if (!ports.worktrees) return { kind: "waiting", slice: id, why: "its worktree is missing and this handle can't create one" };
    const branch = branchName({ title: id });
    worktree = (await ports.worktrees.create({ cwd: root, branch, base: "origin/main", slug: slugOf(id) })).directory;
    writeSliceState(root, mission, id, { worktree });
  }
  if (!state.story || !existsSync(state.story)) {
    const story = join(worktree, ".harness", "story.md");
    mkdirSync(join(worktree, ".harness"), { recursive: true });
    writeFileSync(story, `---\ntitle: ${id}\nstatus: todo\n---\n\n${slice.spec}\n`);
    writeSliceState(root, mission, id, { story });
  }
  const phase = state.design ? "design" : "build";
  writeSliceState(root, mission, id, { phase });
  return { kind: "advanced", slice: id, phase };
}

async function pass(root: string, ports: TickPaseo): Promise<TickResult> {
  const slice = factoryTick(root);
  if (!slice) return { kind: "idle" };
  const moved = await advanceSlice(root, slice, ports);
  if (moved) return moved;
  const seat = SEATS[slice.state.phase];
  if (!seat) return { kind: "waiting", slice: slice.id, why: `${slice.state.phase} is the manager's` };
  const { state } = slice;
  if (!state.worktree || !existsSync(state.worktree)) return { kind: "waiting", slice: slice.id, why: "its worktree is missing" };

  if (state.agent) {
    const session = (await ports.agents.ref(state.agent).refresh())?.agent;
    if (!isDead(session)) return { kind: "alive", slice: slice.id, agent: state.agent };
  }
  // A story the loop's own step session still runs isn't ours yet.
  // Test is the QA seat's, so the builder's finished step session is no loop owner there.
  if (slice.state.phase !== "test" && state.story && existsSync(state.story)) {
    const meta = frontmatter(readFileSync(state.story, "utf8"));
    if (meta.agent && meta.agent !== state.agent && LOOP_STEPS.has(meta.status ?? "")) {
      const loop = (await ports.agents.ref(meta.agent).refresh())?.agent;
      if (!isDead(loop)) return { kind: "waiting", slice: slice.id, why: "the initiative loop still supervises its story" };
    }
  }

  const factory = readFactory(root);
  const mission = factory.missions.find((item) => item.id === slice.mission);
  const prompt = seatPrompt(seat, slice, mission?.outcome ?? "", factory.project, sliceDir(root, slice.mission, slice.id));
  let failure: unknown;
  for (const config of MANAGER_MODELS) {
    try {
      const { id } = await ports.agents.create({
        cwd: state.worktree,
        config,
        prompt,
        env: {},
        title: `${seat}: ${slice.id}`,
        labels: { kind: "factory-seat", seat, slice: slice.id, mission: slice.mission },
      });
      writeSliceState(root, slice.mission, slice.id, { seat, agent: id, attempt: state.attempt + 1 });
      const seatFile = join(factoryDir(root), "seats", `${seat}.md`);
      if (existsSync(seatFile)) writeFrontmatter(seatFile, { agent: id });
      return { kind: "restarted", slice: slice.id, agent: id };
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}
