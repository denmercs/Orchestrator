import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FactorySlice, TICKET_KEY } from "../shared/factory";
import { pipelineSettings } from "../shared/pipeline";
import { DEFAULT_LOOP_CONFIG } from "../shared/initiative-loop";
import { MARKERS, afterImplement, afterReview, commitSubject, readCycles, readMarker, statusSection, writeMarker, type LoopStep } from "../shared/story-method";
import { ciAction } from "./ci-watch";
import { readFactory, writeSliceState } from "./factory-layout";
import type { TickPaseo, TickResult } from "./factory-tick";
import { APPROVE_MESSAGE } from "./gate-actions";
import { storyCost } from "./context-telemetry";
import { frontmatter, writeFrontmatter } from "./harness-layout";
import { storyCap, type ReadCost } from "./initiative-loop";
import { failureReport, prStatus } from "./pr-checks";
import { repoMaxFixes, repoPipelineConfig } from "./repo-pipeline";
import { commitStory, failureText, openStoryPr, pushStoryFix } from "./story-git";
import { launchStep } from "./story-steps";
import { budgetMoney } from "../shared/stats-strip";
import { ROUND_NUDGE_AT, roundNudgeDetail, roundNudgeDue, roundNudgeLine } from "../shared/round-nudge";
import { maybeRoundNudge } from "./round-nudge";

const readText = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

// The QA seat's verdicts. Local to the factory: the loop never reads them, so `MARKERS` doesn't list them.
export const TEST_DONE = "test-done";
export const TEST_FAILED = "test-failed";

// The question that points a fresh agent back at what the slice is for.
export const REFOCUS = "Does this step still serve the spec, the mission outcome and the project intent? If not, stop and say so in `proof.md`, and do not widen the change.";

export const refocusLines = (mission: string, project: string) => [`Mission outcome: ${mission}`, `Project intent: ${project}`, REFOCUS];

const isDead = (session: { status?: string; archivedAt?: string | null } | undefined | null) =>
  !session || Boolean(session.archivedAt) || session.status === "closed" || session.status === "error";

// What telemetry attributes a slice's spend to. A story that lives in an initiative keeps that initiative's slug and its own id,
// so spend from before the factory adopted it adds up; any other story is the mission and the slice.
export function sliceSpendKey(slice: FactorySlice): { initiative: string; story: string } {
  const file = slice.state.story;
  const slug = file ? /[\\/]\.harness[\\/]initiatives[\\/]([^\\/]+)[\\/]/.exec(file)?.[1] : undefined;
  const id = slug && existsSync(file!) ? frontmatter(readText(file!)).id : undefined;
  return slug && id ? { initiative: slug, story: id } : { initiative: slice.mission, story: slice.id };
}

// Starts one loop step in the slice's worktree, as the slice's builder (the reviewer for Review), and records the agent. `attempt` marks a restart
// of a step whose session died: its prompt gets the refocus lines. `failing` is the checks a QA seat saw fail.
function launcher(root: string, slice: FactorySlice, ports: TickPaseo, ctx: Parameters<typeof launchStep>[0]["ctx"]) {
  const { id, mission, state } = slice;
  const steps = ports.steps!;
  const factory = readFactory(root);
  const outcome = factory.missions.find((item) => item.id === mission)?.outcome ?? "";
  const spend = sliceSpendKey(slice);
  return async (step: LoopStep, round: number, extra: { cycle?: ReturnType<typeof readCycles>[number]; attempt?: number; failing?: string } = {}) => {
    const seat = step === "review" ? "reviewer" : "builder";
    const agent = await launchStep({
      api: steps.api,
      storyFile: state.story,
      worktree: state.worktree,
      ctx,
      step,
      round,
      labels: {
        kind: "factory-seat",
        seat,
        "factory-slice": id,
        "factory-mission": mission,
        "loop-initiative": spend.initiative,
        "loop-story": spend.story,
        "loop-step": step,
        "loop-round": String(round),
      },
      readPipeline: steps.readPipeline,
      readAgentConfig: () => steps.readAgentConfig(step),
      create: (spec) =>
        ports.agents.create({
          cwd: state.worktree,
          config: spec.config,
          prompt: extra.attempt ? [spec.prompt, ...refocusLines(outcome, factory.project)].join("\n") : spec.prompt,
          env: {},
          title: spec.title,
          labels: spec.labels,
        }),
      cycle: extra.cycle,
      failing: extra.failing,
      attempt: extra.attempt,
    });
    writeSliceState(root, mission, id, { seat, agent, attempt: state.attempt + (extra.attempt ? 1 : 0) });
    return { kind: "restarted", slice: id, agent } satisfies TickResult;
  };
}

// The failing checks `launchStep` saved on the story (one JSON line), so a restart of the round lists them again.
const storedFailing = (saved: string | undefined) => {
  try {
    const failing: unknown = JSON.parse(saved ?? "");
    return typeof failing === "string" ? failing : undefined;
  } catch {
    return undefined;
  }
};

// A slice that cannot go on tells the manager once and leaves the runnable set (`ready: blocked`), so the next slice can run.
// The manager clears `ready` in the slice's state.md to put it back. Also the block for a seat that looks stuck at its turn end.
export async function block(
  root: string,
  slice: FactorySlice,
  ports: Pick<TickPaseo, "steer">,
  why: string,
  how = "Clear `ready` in its state.md once it is sorted out.",
): Promise<TickResult> {
  await ports.steer?.(`Slice ${slice.id} is blocked: ${why} ${how}`);
  writeSliceState(root, slice.mission, slice.id, { ready: "blocked" });
  return { kind: "waiting", slice: slice.id, why };
}

// The Jira key a slice's work belongs to: its own `jira`, else the `jira` of the story it names (a ticket-started loop story
// has one). Empty when neither holds a well-formed key.
export function sliceTicket(slice: FactorySlice): string {
  if (slice.state.jira) return slice.state.jira;
  const { story } = slice.state;
  const key = story && existsSync(story) ? (frontmatter(readFileSync(story, "utf8")).jira ?? "") : "";
  return TICKET_KEY.test(key) ? key : "";
}

// The story's review rounds, counted apart from `round` (which a failed test run also advances).
const reviewRoundOf = (meta: Record<string, string>) => Number(meta.review_round) || 1;

// `live` is the slice agent's own cost so far, which counts even before its row is written.
const sliceSpend = async (slice: FactorySlice, meta: Record<string, string>, cost: ReadCost, live?: { agentId: string; costUsd: number }) => ({
  spent: storyCost(await cost.rows(), sliceSpendKey(slice), live),
  cap: storyCap(meta, await cost.cap()),
});

// The round 3 nudge for a slice, as one steer to the manager. It counts as delivered only when `steer` exists and
// resolves to something other than `false` (`steerManager` returns false with no manager); a throw is not delivered.
// Its line shows the slice's spend against the story's cap when `cost` is wired; the cap is shown here, not enforced.
async function sliceNudge(slice: FactorySlice, ports: TickPaseo, reviewRound: number): Promise<void> {
  const { steer, cost } = ports;
  const file = slice.state.story;
  if (!steer || !file) return;
  const meta = frontmatter(readText(file));
  if (!roundNudgeDue(meta, reviewRound)) return;
  const spend = cost && (await sliceSpend(slice, meta, cost).catch(() => undefined));
  await maybeRoundNudge(file, reviewRound, roundNudgeLine(slice.id, undefined, spend), async (line) => (await steer(line)) !== false);
}

// A nudge nobody received is still pending: each tick tries again while the slice's review round stays at 3 or more.
export async function retryRoundNudge(slice: FactorySlice, ports: TickPaseo): Promise<void> {
  if (!slice.state.story || !existsSync(slice.state.story)) return;
  await sliceNudge(slice, ports, reviewRoundOf(frontmatter(readText(slice.state.story))));
}

// The cost cap for a slice in build, test or review, checked only once its agent's turn has ended (a dead or missing agent
// counts), so nothing new starts over the cap. At or over it the story is marked `block_kind: cost-cap` and the slice blocks.
// Null when under the cap, mid-turn, or when spend can't be read (no `cost` port, no rows, a reader that throws), except
// that a story still marked `cost-cap` waits while spend can't be read, so the raise isn't lost when the step launches.
export async function sliceCostCap(root: string, slice: FactorySlice, ports: TickPaseo): Promise<TickResult | null> {
  const { cost } = ports;
  const file = slice.state.story;
  if (!cost || !file || !existsSync(file)) return null;
  const session = slice.state.agent ? (await ports.agents.ref(slice.state.agent).refresh())?.agent : undefined;
  if (session?.status === "running" || session?.status === "initializing") return null;
  const liveCost = session?.lastUsage?.totalCostUsd;
  const live = slice.state.agent && typeof liveCost === "number" ? { agentId: slice.state.agent, costUsd: liveCost } : undefined;
  const meta = frontmatter(readText(file));
  const marked = meta.block_kind === "cost-cap";
  const read = await Promise.all([cost.rows(), cost.cap()]).catch(() => undefined);
  if (!read) return marked ? { kind: "waiting", slice: slice.id, why: "its cost can't be read, so the cost cap can't be raised yet" } : null;
  const [rows, base] = read;
  const spent = storyCost(rows, sliceSpendKey(slice), live);
  if (spent === null) return null;
  const cap = storyCap(meta, base);
  // Continue: the manager cleared `ready` on a cost-cap block. The cap goes up by the base cap unless spend is already
  // under it (a cap raised by hand), then the marker is dropped and the step goes on.
  if (marked) {
    if (spent >= cap) writeFrontmatter(file, { cost_cap_usd: cap + base });
    writeFrontmatter(file, { block_kind: null });
    return null;
  }
  if (spent < cap) return null;
  writeFrontmatter(file, { block_kind: "cost-cap" });
  return block(
    root,
    slice,
    ports,
    `cost cap (${roundNudgeDetail({ spent, cap })}).`,
    `Clear \`ready\` in its state.md to continue with the cap raised by ${budgetMoney(base)}, or leave it to stay stopped.`,
  );
}

// `build` runs the loop's steps in the slice's worktree: Plan (Diagnose on a diagnose track), then Implement a cycle at a
// time, committed by the plugin. A step moves on only when its marker is written and the agent's turn has ended. Null
// when this handle can't launch steps, the story isn't ours, or the agent is mid-turn: the pass falls through to seat
// supervision. A Plan turn that ends with no marker is the plan gate: see below.
export async function leaveBuild(
  root: string,
  slice: FactorySlice,
  ports: TickPaseo,
  ctx: Parameters<typeof launchStep>[0]["ctx"],
): Promise<TickResult | null> {
  const { id, mission, state } = slice;
  const { steps } = ports;
  if (!steps || !state.story || !existsSync(state.story) || !state.worktree || !existsSync(state.worktree)) return null;
  const meta = frontmatter(readText(state.story));
  // A story the loop's own session still runs isn't ours yet.
  if (meta.agent && meta.agent !== state.agent && !isDead((await ports.agents.ref(meta.agent).refresh())?.agent)) return null;

  const launch = launcher(root, slice, ports, ctx);
  const first: LoopStep = meta.track === "diagnose" ? "diagnose" : "plan";
  const step = meta.step as LoopStep | undefined;
  if (!step) return launch(first, 1);
  if (step !== "plan" && step !== "diagnose" && step !== "implement") return null;
  const round = Number(meta.round) || 1;

  const session = state.agent ? (await ports.agents.ref(state.agent).refresh())?.agent : undefined;
  if (session?.status === "running" || session?.status === "initializing") return null;
  const worktreeState = readText(join(state.worktree, ".harness", "state.md"));
  const { marker } = readMarker(worktreeState);
  const open = () => readCycles(worktreeState).find((cycle) => !cycle.done);
  if (step !== "implement" && (marker === MARKERS.planDone || marker === MARKERS.diagnoseDone)) return launch("implement", 1, { cycle: open() });
  if (step === "implement" && marker === MARKERS.implementDone) {
    const finished = meta.cycle ? Number(meta.cycle) : null;
    const after = afterImplement(worktreeState, finished);
    if (after.kind === "blocked") return block(root, slice, ports, after.reason);
    const cycle = finished === null ? null : readCycles(worktreeState).find((item) => item.number === finished);
    await (ports.commit ?? commitStory)(state.worktree, commitSubject(worktreeState, cycle?.name ?? ctx.title));
    if (after.kind === "cycle") return launch("implement", round, { cycle: after.cycle });
    // The seat that worked build is done; the QA seat gets a fresh agent.
    writeSliceState(root, mission, id, { phase: "test", seat: null, agent: null });
    return { kind: "advanced", slice: id, phase: "test" };
  }
  if (marker === MARKERS.diagnoseBlocked || marker === MARKERS.implementBlocked) return block(root, slice, ports, `${step} is blocked.`);
  // No marker and the agent is gone: the same step starts again, told that an earlier session stopped.
  if (isDead(session)) return launch(step, round, { attempt: state.attempt + 1, failing: storedFailing(meta.failing) });
  if (step !== "plan") return null;
  // The plan gate: a Plan turn that ended without `plan-done` is the planner asking. The story waits as awaiting-approval
  // and the manager gets one steer; it approves by writing `approve: plan` in the slice's state.md, which is relayed once.
  if (meta.status !== "awaiting-approval") {
    await ports.steer?.(`Slice ${id} has a plan waiting for approval. Write \`approve: plan\` in its state.md to approve it.`);
    writeFrontmatter(state.story, { status: "awaiting-approval" });
    return { kind: "waiting", slice: id, why: "its plan awaits approval" };
  }
  if (state.approve !== "plan" || !state.agent || !ports.send) return { kind: "waiting", slice: id, why: "its plan awaits approval" };
  await ports.send(state.agent, APPROVE_MESSAGE);
  writeSliceState(root, mission, id, { approve: null });
  writeFrontmatter(state.story, { status: "planning" });
  return { kind: "alive", slice: id, agent: state.agent };
}

// `test` is the QA seat's: it runs the checks the spec names, fills `proof.md`, and writes its verdict on the worktree's
// `## Status` (the same place the loop steps write theirs): `test-done`, or `test-failed` with the failing checks on the
// lines after it. A verdict moves the slice only once the seat's turn has ended. Null while there is no verdict, the seat
// is mid-turn, or this handle can't launch steps: the pass falls through to seat supervision (which starts a QA seat).
export async function leaveTest(
  root: string,
  slice: FactorySlice,
  ports: TickPaseo,
  ctx: Parameters<typeof launchStep>[0]["ctx"],
): Promise<TickResult | null> {
  const { id, mission, state } = slice;
  if (!ports.steps || !state.agent || !state.story || !existsSync(state.story) || !state.worktree) return null;
  const session = (await ports.agents.ref(state.agent).refresh())?.agent;
  if (session?.status === "running" || session?.status === "initializing") return null;
  const worktreeState = readText(join(state.worktree, ".harness", "state.md"));
  const { marker } = readMarker(worktreeState);
  if (marker === TEST_DONE) {
    if (!slice.proof) return { kind: "waiting", slice: id, why: "proof.md is empty" };
    writeSliceState(root, mission, id, { phase: "review", seat: null, agent: null });
    return { kind: "advanced", slice: id, phase: "review" };
  }
  if (marker !== TEST_FAILED) return null;
  // Back to build as the next Implement round, told what failed. `fix` stays the CI step's.
  const failing = statusSection(worktreeState).split("\n").map((line) => line.trim()).filter(Boolean).slice(1).join("\n");
  const round = (Number(frontmatter(readText(state.story)).round) || 1) + 1;
  writeSliceState(root, mission, id, { phase: "build" });
  return launcher(root, slice, ports, ctx)("implement", round, { failing: failing || "(the QA seat gave no detail; see `proof.md`)" });
}

// `review` runs the loop's Review step as the reviewer seat. The checklist under `## Review findings` decides, as in the
// loop (`afterReview`): open findings go back to build as the next Implement round, which passes `test` again before the
// next review. A clean review ends in the manager's hands on a scout slice (one steer, `ready: review`, no PR) and moves a
// ship slice to `ship`. Moves only once the reviewer's turn has ended. Null while the reviewer is mid-turn or has written no
// marker, or when this handle can't launch steps: the pass falls through to seat supervision.
export async function leaveReview(
  root: string,
  slice: FactorySlice,
  ports: TickPaseo,
  ctx: Parameters<typeof launchStep>[0]["ctx"],
): Promise<TickResult | null> {
  const { id, mission, state } = slice;
  if (!ports.steps || !state.story || !existsSync(state.story) || !state.worktree || !existsSync(state.worktree)) return null;
  const meta = frontmatter(readText(state.story));
  const launch = launcher(root, slice, ports, ctx);
  const round = Number(meta.round) || 1;
  // Test's QA seat cleared the agent: the story's step is still the builder's, so Review starts fresh.
  if (meta.step !== "review") return launch("review", round);

  const session = state.agent ? (await ports.agents.ref(state.agent).refresh())?.agent : undefined;
  if (session?.status === "running" || session?.status === "initializing") return null;
  const worktreeState = readText(join(state.worktree, ".harness", "state.md"));
  const { marker } = readMarker(worktreeState);
  if (marker !== MARKERS.reviewDone && marker !== MARKERS.reviewFailed) {
    return isDead(session) ? launch("review", round, { attempt: state.attempt + 1 }) : null;
  }
  const maxRounds = repoPipelineConfig(pipelineSettings.schema.parse({}), state.worktree).reviewRounds;
  const reviewRound = reviewRoundOf(meta);
  const after = afterReview(worktreeState, marker, reviewRound, maxRounds);
  if (after.kind === "blocked") return block(root, slice, ports, after.reason);
  if (after.kind === "fix") {
    // Review round 2 has ended and round 3 is about to start: tell the manager before it spends anything.
    if (reviewRound + 1 === ROUND_NUDGE_AT) await sliceNudge(slice, ports, reviewRound + 1);
    writeFrontmatter(state.story, { review_round: reviewRound + 1 });
    writeSliceState(root, mission, id, { phase: "build" });
    return launch("implement", round + 1);
  }
  if (state.kind === "scout") {
    // The manager hears once: `ready` takes the slice out of the runnable set, so no later pass steers again.
    await ports.steer?.(`Slice ${id} passed review and is ready for you. Nothing was pushed and no PR was opened.`);
    writeSliceState(root, mission, id, { ready: "review" });
    return { kind: "waiting", slice: id, why: "it is ready for the manager" };
  }
  writeSliceState(root, mission, id, { phase: "ship", seat: null, agent: null });
  return { kind: "advanced", slice: id, phase: "ship" };
}

// `ship` is the plugin's, with no agent but the Fix step: it opens the PR once (recording `pr`), then watches CI with
// `ciAction(..., false)`. The repo's `autoMerge` is never read and nothing here can merge; the human does. A failing head
// launches the loop's Fix step as the builder (counted in the story's `fix_attempts`, the head kept in `fixed_sha`, as the
// loop does), and its `fix-done` is pushed once. Green CI is the end: one steer and `ready: ci`, which takes the slice out
// of the runnable set. Null while a Fix agent is mid-turn, or when this handle can't launch steps: the pass falls through.
export async function leaveShip(
  root: string,
  slice: FactorySlice,
  ports: TickPaseo,
  ctx: Parameters<typeof launchStep>[0]["ctx"],
): Promise<TickResult | null> {
  const { id, mission, state } = slice;
  if (!ports.steps || !state.story || !existsSync(state.story) || !state.worktree || !existsSync(state.worktree)) return null;
  const meta = frontmatter(readText(state.story));
  const stateFile = join(state.worktree, ".harness", "state.md");
  const worktreeState = readText(stateFile);
  const { marker } = readMarker(worktreeState);

  if (!state.pr) {
    const maxRounds = repoPipelineConfig(pipelineSettings.schema.parse({}), state.worktree).reviewRounds;
    const after = marker ? afterReview(worktreeState, marker, reviewRoundOf(meta), maxRounds) : null;
    const ticket = sliceTicket(slice);
    try {
      const pr = await (ports.openPr ?? openStoryPr)(state.worktree, {
        id: ticket || id,
        title: ctx.title,
        jira: Boolean(ticket),
        branch: meta.branch || ctx.branch,
        base: ctx.base,
        subject: commitSubject(worktreeState, "Commit remaining changes"),
        unfixed: after?.kind === "pr" ? after.unfixed : [],
      });
      if (!pr) {
        await ports.steer?.(`Slice ${id} has nothing to ship: its work is already on ${ctx.base}.`);
        writeSliceState(root, mission, id, { ready: "ci" });
        return { kind: "waiting", slice: id, why: "it has nothing to ship" };
      }
      writeSliceState(root, mission, id, { pr: String(pr.number) });
      writeFrontmatter(state.story, { status: "pr-open", pr: pr.number, ci: "pending" });
      return { kind: "waiting", slice: id, why: `PR #${pr.number} is open` };
    } catch (error) {
      return { kind: "waiting", slice: id, why: `could not open the PR: ${failureText(error)}` };
    }
  }

  const fixer = state.agent ? (await ports.agents.ref(state.agent).refresh())?.agent : undefined;
  const fixing = marker === "fix-running";
  if (fixing && (fixer?.status === "running" || fixer?.status === "initializing")) return null;
  const cwd = state.worktree;
  if (marker === MARKERS.fixDone) {
    try {
      await (ports.push ?? pushStoryFix)(cwd, commitSubject(worktreeState, "Fix failing CI checks"));
    } catch (error) {
      return { kind: "waiting", slice: id, why: `could not push the CI fix: ${failureText(error)}` };
    }
    // The fix is out: the marker no longer says fix-done, so the next pass doesn't push it again.
    writeFileSync(stateFile, writeMarker(worktreeState, MARKERS.prDone), "utf8");
    writeSliceState(root, mission, id, { seat: null, agent: null });
  }

  const pr = await (ports.prStatus ?? prStatus)(cwd, state.pr);
  if (!pr) return { kind: "waiting", slice: id, why: `PR #${state.pr} can't be read` };
  const watch = { fixedSha: meta.fixed_sha ?? null, attempts: Number(meta.fix_attempts) || 0 };
  const action = ciAction(pr, watch, repoMaxFixes(cwd) ?? DEFAULT_LOOP_CONFIG.maxFixes, false);
  const launch = launcher(root, slice, ports, ctx);
  const round = Number(meta.round) || 1;
  const failing = () => (ports.failureReport ?? failureReport)(cwd, pr.failing);
  // A Fix agent that died mid-step starts again on the same head, not as a new attempt.
  if (fixing && isDead(fixer) && action.kind === "wait" && action.ci === "failing") {
    return launch("fix", round, { attempt: state.attempt + 1, failing: await failing() });
  }
  const ci = "ci" in action ? action.ci : null;
  if (ci && meta.ci !== ci) writeFrontmatter(state.story, { ci });
  if (action.kind === "fix") {
    writeFrontmatter(state.story, { fixed_sha: action.headSha, fix_attempts: action.attempt });
    return launch("fix", round, { failing: await failing() });
  }
  if (action.kind === "closed") return block(root, slice, ports, `PR #${pr.number} was closed without merging.`);
  if (action.kind === "merged") {
    writeSliceState(root, mission, id, { ready: "ci" });
    return { kind: "waiting", slice: id, why: `PR #${pr.number} is merged` };
  }
  if (action.kind === "skip" || action.kind === "give-up") {
    await ports.steer?.(`Slice ${id}: ${action.reason}. PR ${pr.url} needs you.`);
    writeSliceState(root, mission, id, { ready: "ci" });
    return { kind: "waiting", slice: id, why: action.reason };
  }
  if (action.kind === "wait" && action.ci === "green") {
    await ports.steer?.(`Slice ${id} is ready for you: PR ${pr.url} is open and CI is green. It is not merged.`);
    writeSliceState(root, mission, id, { ready: "ci" });
    return { kind: "waiting", slice: id, why: "CI is green and the PR awaits a merge" };
  }
  return { kind: "waiting", slice: id, why: `CI is ${action.kind === "wait" ? action.ci : "unknown"}` };
}
