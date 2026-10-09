import type { Gate } from "./gates";
import type { ContextSummary } from "./context";
import type { EpicBoard } from "./orchestration";

// The stats strip's five numbers (see CONTEXT.md, "Stats strip"). Pure: the client maps `tone` to
// theme tokens ("warning" → statusWarning).

export type StatTone = "default" | "warning";
export type Stat = { label: string; value: string; sub: string; tone: StatTone };

export type Spend = Pick<ContextSummary, "spendToday" | "spendWeek">;
export type Budget = { dailyBudgetUsd: number; storyCapUsd: number };

// An agent is mid-step; awaiting-approval and pr-open are waits, not work.
const RUNNING = new Set(["planning", "implementing", "reviewing"]);

const money = (usd: number) => `$${usd.toFixed(2)}`;
// Whole-dollar budgets read as "$25", others with cents.
const budgetMoney = (usd: number) => (Number.isInteger(usd) ? `$${usd}` : money(usd));

export function statsOf(input: { boards: EpicBoard[]; gates: Gate[]; spend: Spend | null; budget: Budget }): Stat[] {
  const stories = input.boards.flatMap((board) => board.state?.stories ?? []);
  const running = stories.filter((story) => RUNNING.has(story.status)).length;
  const ready = stories.filter((story) => story.ready).length;
  const merged = stories.filter((story) => story.status === "merged").length;
  const gates = input.gates.length;
  const budget = `of ${budgetMoney(input.budget.dailyBudgetUsd)} budget`;
  return [
    { label: "Running", value: String(running), sub: "agents working", tone: "default" },
    { label: "Ready", value: String(ready), sub: "waiting to start", tone: "default" },
    { label: "Needs you", value: String(gates), sub: "agents paused at gates", tone: gates > 0 ? "warning" : "default" },
    { label: "Merged", value: `${merged}/${stories.length}`, sub: "stories across initiatives", tone: "default" },
    {
      label: "Spend today",
      value: input.spend ? money(input.spend.spendToday) : "—",
      sub: input.spend ? `${budget} · ${money(input.spend.spendWeek)} this week` : budget,
      tone: "default",
    },
  ];
}

// Local midnight of the given day: the `today` the spend summary is asked for.
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
