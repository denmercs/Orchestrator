import type { PrStatus } from "./pr-checks";

// The CI watcher for a story PR, shared by the initiative loop and the Story pipeline. Plain code, no
// agent: each tick reads the PR through `prStatus` and this decides what happens next. A failing head
// commit gets one Fix CI agent; its push makes a new head, which CI checks again, until the checks
// pass or `maxFixes` attempts have been spent. Each caller stores the CiWatch where it keeps its
// story's state (story frontmatter, or the worktree's .harness/ci.json).

export type CiWatch = {
  // The head commit a Fix CI agent was last started for, so the same failure isn't fixed twice.
  fixedSha: string | null;
  attempts: number;
};

export type CiState = "pending" | "green" | "failing" | "none";

export type CiAction =
  | { kind: "merged" }
  | { kind: "closed" }
  | { kind: "wait"; ci: CiState }
  | { kind: "fix"; ci: "failing"; attempt: number; headSha: string }
  | { kind: "give-up"; ci: "failing"; reason: string };

export function ciAction(pr: PrStatus, watch: CiWatch, maxFixes: number): CiAction {
  if (pr.state === "merged") return { kind: "merged" };
  if (pr.state === "closed") return { kind: "closed" };
  if (pr.state !== "failing") return { kind: "wait", ci: pr.state === "no-checks" ? "none" : pr.state };
  if (watch.fixedSha === pr.headSha) return { kind: "wait", ci: "failing" };
  if (watch.attempts >= maxFixes) {
    const names = pr.failing.map((check) => check.name).join(", ");
    return { kind: "give-up", ci: "failing", reason: `CI still failing after ${watch.attempts} fix attempts: ${names}` };
  }
  return { kind: "fix", ci: "failing", attempt: watch.attempts + 1, headSha: pr.headSha };
}
