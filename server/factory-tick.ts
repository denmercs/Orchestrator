import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FactoryPhase, FactorySlice } from "../shared/factory";
import { type ManagerPaseo, MANAGER_MODELS } from "./factory-manager";
import { factoryDir, factoryTick, readFactory, sliceDir, writeSliceState } from "./factory-layout";
import { frontmatter, writeFrontmatter } from "./harness-layout";

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
  agents: {
    ref(id: string): { refresh(): Promise<{ agent: { status?: string; archivedAt?: string | null } } | null> };
    create(request: Parameters<ManagerPaseo["agents"]["create"]>[0] & { prompt: string }): Promise<{ id: string }>;
  };
};

export type TickResult =
  | { kind: "idle" }
  | { kind: "waiting"; slice: string; why: string }
  | { kind: "alive"; slice: string; agent: string }
  | { kind: "restarted"; slice: string; agent: string };

const isDead = (session: { status?: string; archivedAt?: string | null } | undefined | null) =>
  !session || Boolean(session.archivedAt) || session.status === "closed" || session.status === "error";

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
    "Does this step still serve the spec, the mission outcome and the project intent? If not, stop and say so in `proof.md`, and do not widen the change.",
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

async function pass(root: string, ports: TickPaseo): Promise<TickResult> {
  const slice = factoryTick(root);
  if (!slice) return { kind: "idle" };
  const seat = SEATS[slice.state.phase];
  if (!seat) return { kind: "waiting", slice: slice.id, why: `${slice.state.phase} is the manager's` };
  const { state } = slice;
  if (!state.worktree || !existsSync(state.worktree)) return { kind: "waiting", slice: slice.id, why: "its worktree is missing" };

  if (state.agent) {
    const session = (await ports.agents.ref(state.agent).refresh())?.agent;
    if (!isDead(session)) return { kind: "alive", slice: slice.id, agent: state.agent };
  }
  // A story the loop's own step session still runs isn't ours yet.
  if (state.story && existsSync(state.story)) {
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
