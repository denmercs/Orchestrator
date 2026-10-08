import { needsYou } from "./gates";
import type { EpicBoardState, EpicStory } from "./orchestration";

// Which first step a story runs: a feature is planned, a bug is diagnosed.
export type Track = "plan" | "diagnose";

// One step of the bar: finished, running, waiting on you, or not reached.
export type Segment = "done" | "now" | "gate" | "todo";

export type StepBar = {
  segments: Segment[];
  labels: string[];
  sub: string;
  detail: string;
  cta: string;
};

const LABELS = ["Plan", "Implement", "Review", "PR", "CI watch"];

// The step a status runs on. The loop's PR step runs under `reviewing`; once a PR is open, PR is done
// and the story is on CI watch.
const STEP = new Map<string, number>([
  ["todo", 0],
  ["planning", 0],
  ["awaiting-approval", 0],
  ["implementing", 1],
  ["reviewing", 2],
  ["pr-open", 4],
]);

// Steps before `at` are done, `at` is `current`, after it are todo.
const bar = (at: number, current: Segment): Segment[] =>
  LABELS.map((_, i) => (i < at ? "done" : i === at ? current : "todo"));

function segmentsOf(story: EpicStory): Segment[] {
  switch (story.status) {
    case "todo":
      return bar(0, "todo");
    case "planning":
    case "implementing":
    case "reviewing":
      return bar(STEP.get(story.status) ?? 0, "now");
    case "awaiting-approval":
      return bar(0, "gate");
    case "pr-open":
      return bar(4, story.ci === "green" ? "gate" : "now");
    case "blocked":
      return bar(STEP.get(story.blockedFrom) ?? 0, "gate");
    case "merged":
      return bar(LABELS.length, "done");
    default:
      return bar(0, "todo");
  }
}

type Text = Pick<StepBar, "sub" | "detail" | "cta">;

// The dependency a waiting story is after: the first one not merged in this board, else its first.
function waitingOn(story: EpicStory, stories: EpicStory[] | undefined): string | undefined {
  const merged = new Set((stories ?? []).filter((s) => s.status === "merged").map((s) => s.id));
  return story.dependsOn.find((id) => !merged.has(id)) ?? story.dependsOn[0];
}

function textOf(story: EpicStory, track: Track, stories: EpicStory[] | undefined): Text {
  const diagnose = track === "diagnose";
  const pr = `PR #${story.pr ?? ""}`;
  switch (story.status) {
    case "todo": {
      if (story.ready) return { sub: "Ready to start", detail: "No blockers", cta: "Start agent" };
      const dep = waitingOn(story, stories);
      return dep
        ? { sub: `after ${dep}`, detail: `Waiting on ${dep}`, cta: "View plan" }
        : { sub: "Waiting", detail: "Waiting", cta: "View plan" };
    }
    case "planning":
      return diagnose
        ? { sub: "Diagnosing", detail: "Diagnosing the bug", cta: "Open session" }
        : { sub: "Planning", detail: "Writing the plan", cta: "Open session" };
    case "awaiting-approval":
      return {
        sub: diagnose ? "Diagnosis awaiting approval" : "Plan awaiting approval",
        detail: "Plan ready for your approval",
        cta: "Review plan",
      };
    case "implementing":
      return { sub: "Implementing", detail: "Implement", cta: "Open session" };
    case "reviewing":
      return { sub: "Reviewing", detail: "Review", cta: "Open session" };
    case "pr-open":
      if (story.ci === "green") {
        return { sub: "Ready to merge", detail: `${pr} passed Review and CI`, cta: "Review & merge" };
      }
      if (story.ci === "failing") {
        return { sub: "CI failing", detail: `${pr} · CI failing, fixing`, cta: "Open session" };
      }
      return { sub: "CI running", detail: `${pr} · CI running`, cta: "Open PR" };
    case "blocked":
      return { sub: "Stuck · no progress", detail: story.blockedReason || "Blocked", cta: "Open session" };
    case "merged":
      return story.pr === null
        ? { sub: "Merged", detail: "Merged in main", cta: "Open PR" }
        : { sub: `Merged #${story.pr}`, detail: `Merged in #${story.pr}`, cta: "Open PR" };
    default:
      return { sub: story.status, detail: story.status, cta: "Open session" };
  }
}

// `stories` is the story's board, used to name the first unmerged dependency a todo story waits on.
export function stepBar(story: EpicStory, track: Track, stories?: EpicStory[]): StepBar {
  const labels = track === "diagnose" ? ["Diagnose", ...LABELS.slice(1)] : [...LABELS];
  return { segments: segmentsOf(story), labels, ...textOf(story, track, stories) };
}

// The initiative's badge on the board header.
export type InitiativeBadge = "Needs plan" | "Planning" | "Done" | "Needs you" | "In progress" | "Ready";

const RUNNING = new Set(["planning", "implementing", "reviewing", "pr-open"]);

// First match wins. Uses `needsYou` so the badge agrees with the gate queue.
export function initiativeStatus(state: EpicBoardState): InitiativeBadge {
  const { stories } = state;
  if (stories.length === 0) return state.plan === null ? "Needs plan" : "Planning";
  if (stories.every((s) => s.status === "merged")) return "Done";
  if (stories.some(needsYou)) return "Needs you";
  if (stories.some((s) => RUNNING.has(s.status))) return "In progress";
  if (stories.some((s) => s.ready)) return "Ready";
  return "In progress";
}
