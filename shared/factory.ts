// The factory's files read into types. No Node imports here: server/factory-layout.ts does the file work.
export type FactoryPhase = "spec" | "design" | "build" | "test" | "review" | "ship";
export type FactoryKind = "scout" | "ship";

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
  };
}

export const parseSeat = (role: string, fields: Record<string, string>, body: string): FactorySeat => ({
  role,
  profile: fields.profile ?? "",
  skills: list(fields.skills),
  agent: fields.agent ?? "",
  notes: body,
});

// Until S6: the first slice in mission order, then slice order, with run on. depends is ignored; at most one runs.
export const runnableSlice = (factory: Factory): FactorySlice | null =>
  factory.missions.flatMap((mission) => mission.slices).find((slice) => slice.state.run) ?? null;
