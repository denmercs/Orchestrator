import { phaseSkills, type Phase, type PhaseId, type Then } from "../shared/pipeline";

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
