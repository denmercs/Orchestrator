// The factory's files read into types. No Node imports here: server/factory-layout.ts does the file work.
export type FactoryPhase = "spec" | "design" | "build" | "test" | "review" | "ship";
export type FactoryKind = "scout" | "ship";
// Set when the slice has gone as far as the factory takes it: after a clean review (scout) or green CI (ship), or `blocked`
// when it cannot go on without the manager.
export type SliceReady = "" | "review" | "ci" | "blocked";

export type SliceState = {
  phase: FactoryPhase;
  seat: string;
  agent: string;
  attempt: number;
  worktree: string;
  story: string;
  kind: FactoryKind;
  depends: string[];
  run: boolean;
  design: boolean;
  ready: SliceReady;
  approve: "" | "plan";
  pr: string;
  // The cause the manager was last told holds the slice (`blocked dependency X`, `unknown dependency Y`); empty when none.
  held: string;
};

export type FactorySlice = { id: string; mission: string; state: SliceState; spec: string; design: string; proof: string };
export type FactoryMission = { id: string; outcome: string; slices: FactorySlice[] };
export type FactorySeat = { role: string; profile: string; skills: string[]; agent: string; notes: string };
export type Factory = {
  project: string;
  manager: { agent: string };
  culture: string;
  seats: FactorySeat[];
  missions: FactoryMission[];
};

const PHASES: FactoryPhase[] = ["spec", "design", "build", "test", "review", "ship"];
const list = (value: string | undefined) => (value ? value.split(",").map((part) => part.trim()).filter(Boolean) : []);

export function parseSliceState(fields: Record<string, string>): SliceState {
  const attempt = Number(fields.attempt);
  return {
    phase: PHASES.find((phase) => phase === fields.phase) ?? "spec",
    seat: fields.seat ?? "",
    agent: fields.agent ?? "",
    attempt: Number.isInteger(attempt) && attempt >= 0 ? attempt : 0,
    worktree: fields.worktree ?? "",
    story: fields.story ?? "",
    kind: fields.kind === "ship" ? "ship" : "scout",
    depends: list(fields.depends),
    run: fields.run === "on",
    design: fields.design === "on",
    ready: fields.ready === "review" || fields.ready === "ci" || fields.ready === "blocked" ? fields.ready : "",
    approve: fields.approve === "plan" ? "plan" : "",
    pr: fields.pr ?? "",
    held: fields.held ?? "",
  };
}

export const parseSeat = (role: string, fields: Record<string, string>, body: string): FactorySeat => ({
  role,
  profile: fields.profile ?? "",
  skills: list(fields.skills),
  agent: fields.agent ?? "",
  notes: body,
});

const isDone = (slice: FactorySlice) => slice.proof.trim() !== "" && (slice.state.ready === "review" || slice.state.ready === "ci");

// Every slice that can run now, in mission then slice order: run on, not ready, every depends id a done slice of the same
// mission (an unknown id is not done), and no earlier mission open (a run: on slice that is not done).
export const runnableSlices = (factory: Factory): FactorySlice[] => {
  const runnable: FactorySlice[] = [];
  for (const mission of factory.missions) {
    const done = new Set(mission.slices.filter(isDone).map((slice) => slice.id));
    runnable.push(
      ...mission.slices.filter((slice) => slice.state.run && !slice.state.ready && slice.state.depends.every((id) => done.has(id))),
    );
    if (mission.slices.some((slice) => slice.state.run && !isDone(slice))) break;
  }
  return runnable;
};

// Why a run: on, not ready slice can't start until the manager acts: its first depends id that is a `ready: blocked` slice
// or not a slice of its own mission. Null otherwise: a dependency still in progress is a normal wait.
export const heldBy = (slice: FactorySlice, mission: FactoryMission): string | null => {
  if (!slice.state.run || slice.state.ready) return null;
  for (const id of slice.state.depends) {
    const dependency = mission.slices.find((item) => item.id === id);
    if (!dependency) return `unknown dependency ${id}`;
    if (dependency.state.ready === "blocked") return `blocked dependency ${id}`;
  }
  return null;
};
