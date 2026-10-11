import { MACHINE_SOURCE, phaseSkills, type Phase, type PhaseId, type SkillSource, type SourceStatus, type Then } from "../shared/pipeline";

// Option labels for the Then handoff: plain words, no glyphs.
export const THEN_OPTION_LABEL: Record<Then, string> = {
  auto: "auto",
  you: "wait for you",
  pass: "on PASS",
  merge: "on merge",
};

// Card summary line: what the phase runs, then the extra skills it also loads.
export function phaseSummary(phase: Phase) {
  const { runs, extras } = phaseSkills(phase);
  return {
    runs: runs?.name ?? "built-in step",
    extras: extras.length > 0 ? `  + ${extras.map((e) => e.name).join(", ")}` : "",
  };
}

// The chip between card `index` and the next one.
export function handoffChip(phases: Phase[], index: number) {
  const phase = phases[index];
  const next = phases[index + 1];
  const then = phase?.then ?? "merge";
  const word = THEN_OPTION_LABEL[then];
  const label = then === "merge" || !next ? word : `${word} → ${next.label}`;
  return { label, auto: then === "auto" };
}

// One chip under every card, the last included: Done hands off "on merge" to Story closed.
export function handoffChips(phases: Phase[]) {
  return phases.map((_, index) => handoffChip(phases, index));
}

export const DRAWER_TABS = [
  { id: "phases", label: "Phases" },
  { id: "context", label: "Context" },
  { id: "sources", label: "Sources" },
] as const;

export type DrawerTab = (typeof DRAWER_TABS)[number]["id"];

// Accordion: tapping the open card closes it, tapping another opens that one.
export function nextOpen(open: PhaseId | null, id: PhaseId): PhaseId | null {
  return open === id ? null : id;
}

export const SCOPE_LABEL: Record<SkillSource["kind"], string> = {
  team: "Team",
  personal: "Personal",
  imported: "Imported",
};

const plural = (n: number) => `${n} ${n === 1 ? "skill" : "skills"}`;

// First 7 characters of a commit.
const short = (sha: string) => sha.slice(0, 7);

// One row per place skills come from: this machine first, then each connected source.
export function sourceRows(sources: SkillSource[], statuses: SourceStatus[], machineCount: number) {
  const machine = {
    id: MACHINE_SOURCE,
    name: "This machine",
    icon: "machine" as "machine" | "github" | "folder",
    scope: "Global",
    detail: "~/.claude/skills · ~/.agents/skills · ~/.claude/commands",
    meta: `${plural(machineCount)} · already global, nothing copied`,
    fixed: true,
    error: false,
  };
  const rows = sources.map((source) => {
    const status = statuses.find((s) => s.id === source.id);
    const failed = status ? !status.ok : false;
    const count = failed ? (status?.error ?? "error") : plural(status?.skillCount ?? 0);
    const lead = source.pin ? `Pinned @ ${short(status?.commit ?? source.pin)}` : "Folder · read live";
    return {
      id: source.id,
      name: source.label,
      icon: (source.pin ? "github" : "folder") as "machine" | "github" | "folder",
      scope: SCOPE_LABEL[source.kind],
      detail: source.location,
      meta: `${lead} · ${count}${source.enabled ? "" : " · off"}`,
      fixed: false,
      error: failed,
    };
  });
  return [machine, ...rows];
}

export const ADD_MODES = [
  { id: "repo", label: "Connect repo" },
  { id: "search", label: "Search skills.sh" },
] as const;

export type AddMode = (typeof ADD_MODES)[number]["id"];

// A draft starting with / or ~ is a folder path; anything else, blank included, is a git repo.
export function draftKind(draft: string): "folder" | "github" {
  const text = draft.trim();
  return text.startsWith("/") || text.startsWith("~") ? "folder" : "github";
}

// The line under the connect input, following what is typed.
export function repoHint(draft: string) {
  if (draft.trim() === "") {
    return "Git repos are cloned and pinned to the current commit. Folders are read live.";
  }
  return draftKind(draft) === "folder"
    ? "Folder: read live, changes show up on Reload."
    : "Git repo: cloned and pinned to the current commit.";
}
