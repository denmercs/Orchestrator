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
  // The Paseo workspace holding the worktree; empty when none is on record.
  workspace: string;
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
  // The Jira key this slice's work belongs to (`ABC-12`); empty when it has none. Only a well-formed key counts.
  jira: string;
  // When the slice's PR was seen merged (the PR's merged-at time); empty until then.
  merged: string;
  // `plan` once the manager was told this slice's plan awaits approval; cleared when the approval is relayed.
  steered: "" | "plan";
  // The manager's word that a slice is finished (a scout slice has no merge to wait for): the close pass archives its workspace.
  close: boolean;
  // The close pass archived the slice's workspace.
  archived: boolean;
  // The manager was told the archive is held back by a running agent.
  archive_held: boolean;
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
// A Jira issue key: project letters or digits, a dash, the number.
export const TICKET_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const list = (value: string | undefined) => (value ? value.split(",").map((part) => part.trim()).filter(Boolean) : []);

export function parseSliceState(fields: Record<string, string>): SliceState {
  const attempt = Number(fields.attempt);
  return {
    phase: PHASES.find((phase) => phase === fields.phase) ?? "spec",
    seat: fields.seat ?? "",
    agent: fields.agent ?? "",
    attempt: Number.isInteger(attempt) && attempt >= 0 ? attempt : 0,
    worktree: fields.worktree ?? "",
    workspace: fields.workspace ?? "",
    story: fields.story ?? "",
    kind: fields.kind === "ship" ? "ship" : "scout",
    depends: list(fields.depends),
    run: fields.run === "on",
    design: fields.design === "on",
    ready: fields.ready === "review" || fields.ready === "ci" || fields.ready === "blocked" ? fields.ready : "",
    approve: fields.approve === "plan" ? "plan" : "",
    pr: fields.pr ?? "",
    held: fields.held ?? "",
    jira: TICKET_KEY.test(fields.jira ?? "") ? fields.jira : "",
    merged: fields.merged ?? "",
    steered: fields.steered === "plan" ? "plan" : "",
    close: fields.close === "on",
    archived: fields.archived === "on",
    archive_held: fields.archive_held === "on",
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

// Every ship slice waiting on a human to merge its PR: ready at ci, with a pr, not yet recorded merged. The tick polls these.
export const mergeWatch = (factory: Factory): FactorySlice[] =>
  factory.missions.flatMap((mission) =>
    mission.slices.filter((slice) => slice.state.kind === "ship" && slice.state.ready === "ci" && slice.state.pr !== "" && !slice.state.merged),
  );

// Why a run: on, not ready slice can't start until the manager acts: its first depends id that is a `ready: blocked` slice,
// is not a slice of its own mission, or is idle (`run` off and not done, so nothing will ever run it); or a depends chain that
// loops back to the slice (itself included). Null otherwise: a dependency still in progress is a normal wait.
export const heldBy = (slice: FactorySlice, mission: FactoryMission): string | null => {
  if (!slice.state.run || slice.state.ready) return null;
  for (const id of slice.state.depends) {
    const dependency = mission.slices.find((item) => item.id === id);
    if (!dependency) return `unknown dependency ${id}`;
    if (dependency.state.ready === "blocked") return `blocked dependency ${id}`;
  }
  const loop = dependencyLoop(slice, mission);
  if (loop) return `dependency loop ${loop.join(" -> ")}`;
  for (const id of slice.state.depends) {
    const dependency = mission.slices.find((item) => item.id === id);
    if (dependency && !dependency.state.run && !isDone(dependency)) return `idle dependency ${id}`;
  }
  return null;
};

// The depends chain from `slice` back to itself, as ids from the slice and ending on it, or null. Ids outside the mission end a chain.
const dependencyLoop = (slice: FactorySlice, mission: FactoryMission): string[] | null => {
  const walk = (current: FactorySlice, path: string[]): string[] | null => {
    for (const id of current.state.depends) {
      if (id === slice.id) return [...path, id];
      const next = mission.slices.find((item) => item.id === id);
      if (next && !path.includes(id)) {
        const found = walk(next, [...path, id]);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(slice, [slice.id]);
};
