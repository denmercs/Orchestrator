import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type FactoryPhase, type FactorySeat, type FactorySlice, heldBy } from "../shared/factory";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { type AgentCreateConfig, type AgentProfile, materializeProfile, seatProfile } from "../shared/agent-runner";
import type { Phase, SkillSource } from "../shared/pipeline";
import { branchName } from "../shared/naming";
import type { LoopHost } from "../shared/loop-host";
import type { LoopStep, StoryContext } from "../shared/story-method";
import { type ManagerPaseo, MANAGER_MODELS } from "./factory-manager";
import { factoryDir, factoryTick, readFactory, sliceDir, writeSliceState } from "./factory-layout";
import { REFOCUS, TEST_DONE, TEST_FAILED, leaveBuild, leaveReview, leaveShip, leaveTest, retryRoundNudge, sliceCostCap, sliceSpendKey, startSeat } from "./factory-phases";
import { closeSlices, runRequestedSweep } from "./factory-workspace";
import { frontmatter, slugOf, writeFrontmatter } from "./harness-layout";
import type { FailingCheck, PrStatus } from "./pr-checks";
import type { ReadCost } from "./initiative-loop";
import type { OpenedPr } from "./story-git";
import { MARK } from "./story-steps";

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
  // The loop's own host: a fresh slice gets its workspace and worktree from it. Absent in a handle that can't make one.
  host?: LoopHost;
  // What `launchStep` needs to run a loop step in a slice's worktree. Absent in a handle that can't: build then falls through to seat supervision.
  steps?: {
    api: PluginHandlerContext["paseo"];
    readPipeline: () => Promise<{ phases: Phase[]; sources: SkillSource[] }>;
    // The runner config for a step: the loop picks a per-step profile, so the step is passed.
    readAgentConfig: (step: LoopStep) => Promise<AgentCreateConfig>;
  };
  // The telemetry rows and base cap a slice's spend and cap are read from, for the round 3 nudge and the build, test and review cost cap. Absent: the nudge leaves spend out and the slice is not capped.
  cost?: ReadCost;
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
  // The Paseo agent profiles and the runner's profile id, to resolve a seat's profile. Absent or failing: seats start on MANAGER_MODELS.
  profiles?: () => Promise<{ list: AgentProfile[]; runnerProfileId: string }>;
  agents: {
    ref(id: string): { refresh(): Promise<{ agent: { status?: string; archivedAt?: string | null; lastUsage?: { totalCostUsd?: number } | null } } | null> };
    create(request: Omit<Parameters<ManagerPaseo["agents"]["create"]>[0], "config"> & { prompt: string; config: AgentCreateConfig }): Promise<{ id: string }>;
  };
};

export type TickResult =
  | { kind: "idle" }
  | { kind: "waiting"; slice: string; why: string }
  | { kind: "advanced"; slice: string; phase: FactoryPhase }
  | { kind: "alive"; slice: string; agent: string }
  | { kind: "restarted"; slice: string; agent: string }
  | { kind: "fan-out"; results: TickResult[] };

export const isDead = (session: { status?: string; archivedAt?: string | null } | undefined | null) =>
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

// One factory pass: walks every runnable slice and, when its seat's agent is missing, archived, closed or in error,
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
  if (["build", "test", "review"].includes(slice.state.phase)) {
    await retryRoundNudge(slice, ports);
    const capped = await sliceCostCap(root, slice, ports);
    if (capped) return capped;
  }
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
  writeSliceState(root, mission, id, { phase: "build", seat: null, agent: null });
  return { kind: "advanced", slice: id, phase: "build" };
}

// The story context a slice's loop steps run with. The body is the spec, then the design when the slice has one, so the
// builder's Plan sees both. Build steps (cycle 5) pass this to `launchStep`.
export function buildContext(slice: FactorySlice): StoryContext {
  // A named story's own id and title name the sessions, as the loop's do; the branch still comes from the slice id.
  const meta = slice.state.story && existsSync(slice.state.story) ? frontmatter(readFileSync(slice.state.story, "utf8")) : {};
  return {
    id: meta.id || slice.id,
    title: meta.title || slice.id,
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
  // The story's live agent becomes the slice's, so the tick reads that agent's turn end instead of starting another.
  const seat = phase === "review" ? "reviewer" : "builder";
  writeSliceState(root, mission, id, { phase, ...(meta.agent ? { seat, agent: meta.agent } : {}), ...(phase === "ship" && !state.pr && meta.pr ? { pr: meta.pr } : {}), ...(!state.workspace && meta.workspace ? { workspace: meta.workspace } : {}) });
  if (state.worktree && !meta.worktree) writeFrontmatter(state.story, { worktree: state.worktree });
  return { kind: "advanced", slice: id, phase };
}

// `spec` is the manager's: a written spec.md is the evidence. The slice gets a worktree and a story file first (each saved
// as it's made, so a failed pass resumes), then goes to design when its state says so, else to build.
async function leaveSpec(root: string, slice: FactorySlice, ports: TickPaseo): Promise<TickResult> {
  const { id, mission, state } = slice;
  if (!slice.spec) return { kind: "waiting", slice: id, why: "its spec is empty" };
  let worktree = state.worktree;
  let workspace = state.workspace;
  if (!worktree || !existsSync(worktree)) {
    if (!ports.host) return { kind: "waiting", slice: id, why: "its worktree is missing and this handle can't create one" };
    const names = buildContext(slice);
    const projects = await ports.host.listProjects();
    const project = projects.find((item) => resolve(item.projectRootPath) === resolve(root));
    const created = await ports.host.createStoryWorkspace({
      title: (names.title === names.id ? `${MARK} ${names.id}` : `${MARK} ${names.id} — ${names.title}`).slice(0, 60),
      repoRoot: root,
      ...(project ? { projectId: project.projectId } : {}),
      baseBranch: "origin/main",
      branchName: branchName({ title: id }),
      worktreeSlug: slugOf(id),
    });
    worktree = created.directory;
    workspace = created.id;
    writeSliceState(root, mission, id, { worktree, workspace });
  }
  if (!state.story || !existsSync(state.story)) {
    const story = join(worktree, ".harness", "story.md");
    mkdirSync(join(worktree, ".harness"), { recursive: true });
    writeFileSync(story, `---\ntitle: ${id}\nstatus: todo\nworktree: ${worktree}\n${workspace ? `workspace: ${workspace}\n` : ""}---\n\n${slice.spec}\n`);
    writeSliceState(root, mission, id, { story });
  } else {
    // A story the manager named carries the worktree too, or the context watch and resume can't find its state, and the workspace.
    const meta = frontmatter(readFileSync(state.story, "utf8"));
    const missing = { ...(meta.worktree ? {} : { worktree }), ...(!meta.workspace && workspace ? { workspace } : {}) };
    if (Object.keys(missing).length) writeFrontmatter(state.story, missing);
  }
  const phase = state.design ? "design" : "build";
  writeSliceState(root, mission, id, { phase });
  return { kind: "advanced", slice: id, phase };
}

// The seat's own model config (its file's profile, else its role's tier), or none to start on MANAGER_MODELS.
async function seatConfig(seat: FactorySeat | undefined, role: string, ports: TickPaseo): Promise<AgentCreateConfig[]> {
  if (!ports.profiles) return [];
  try {
    const { list, runnerProfileId } = await ports.profiles();
    const profile = seatProfile(seat, role, list, runnerProfileId);
    return profile ? [materializeProfile(profile)] : [];
  } catch {
    return [];
  }
}

// One pass over every runnable slice, one after another so the seat file and the slice files never get two writers.
// Each slice has its own try: one slice's failure doesn't stop the others, and once all have run a lone error is rethrown as is, several as one AggregateError.
async function pass(root: string, ports: TickPaseo): Promise<TickResult> {
  const results: TickResult[] = [];
  const failures: unknown[] = [];
  try {
    await noteHeld(root, ports);
  } catch (error) {
    failures.push(error);
  }
  try {
    await closeSlices(root, ports);
  } catch (error) {
    failures.push(error);
  }
  try {
    await runRequestedSweep(root, ports);
  } catch (error) {
    failures.push(error);
  }
  // A slice whose workspace is closed or archived starts no more seats: they would run in a checkout that is gone.
  for (const slice of factoryTick(root).filter((item) => !item.state.close && !item.state.archived)) {
    try {
      results.push(await passSlice(root, slice, ports));
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, failures.map(String).join("; "));
  if (results.length === 0) return { kind: "idle" };
  return results.length === 1 ? results[0] : { kind: "fan-out", results };
}

// A slice held by a blocked or unknown dependency would wait in silence: the manager hears once per cause, and `held` in
// state.md remembers it across passes and restarts. It clears when the cause goes away, so a later cause steers again.
// `held` is saved only when the steer was delivered (the round 3 nudge's rule): no steer, a `false` or a throw leaves it
// unchanged, so the next pass tries again.
async function noteHeld(root: string, ports: TickPaseo) {
  const { steer } = ports;
  for (const mission of readFactory(root).missions) {
    for (const slice of mission.slices) {
      const cause = heldBy(slice, mission);
      if ((cause ?? "") === slice.state.held) continue;
      if (cause) {
        const line = `Slice ${slice.id} can't start: ${cause}.`;
        const delivered = steer && (await Promise.resolve().then(() => steer(line)).catch(() => false)) !== false;
        if (!delivered) continue;
      }
      writeSliceState(root, mission.id, slice.id, { held: cause });
    }
  }
}

const SEAT_STEPS: Record<string, string> = { design: "Design", qa: "Test" };

// Design and QA seats are titled like the loop's steps, from the named story's id and title.
function seatTitle(seat: string, slice: FactorySlice): string {
  const step = SEAT_STEPS[seat];
  if (!step) return `${seat}: ${slice.id}`;
  const { id, title } = buildContext(slice);
  return `${MARK} ${id} · ${step} — ${title}`.slice(0, 60);
}

async function passSlice(root: string, slice: FactorySlice, ports: TickPaseo): Promise<TickResult> {
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
  const spend = sliceSpendKey(slice);
  let failure: unknown;
  for (const config of [...(await seatConfig(factory.seats.find((item) => item.role === seat), seat, ports)), ...MANAGER_MODELS]) {
    try {
      const { id } = await startSeat(slice, ports, {
        config,
        prompt,
        title: seatTitle(seat, slice),
        labels: { kind: "factory-seat", seat, slice: slice.id, mission: slice.mission, "loop-initiative": spend.initiative, "loop-story": spend.story },
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
