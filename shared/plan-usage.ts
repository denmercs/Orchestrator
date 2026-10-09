import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Plan usage (see CONTEXT.md, "Plan usage"): each provider's plan windows and balances as the Paseo
// daemon reports them through `paseo.providers.listUsage()`. Pure: the client maps `tone` to theme
// tokens ("danger" → statusDanger). Nothing here is estimated; a phrase the daemon gives no time for
// is left out.

// The subset of `ProviderUsage` (@getpaseo/protocol) the rows read; other fields are dropped.
const usageTone = z.enum(["default", "ok", "warning", "danger"]);

const usageWindow = z.object({
  id: z.string(),
  label: z.string(),
  usedPct: z.number().nullish(),
  resetsAt: z.string().nullish(),
  runsOutAt: z.string().nullish(),
  tone: usageTone.optional(),
});

const usageBalance = z.object({
  id: z.string(),
  label: z.string(),
  used: z.number().nullish(),
  limit: z.number().nullish(),
  unit: z.enum(["tokens", "usd", "credits", "requests"]),
  resetsAt: z.string().nullish(),
  tone: usageTone.optional(),
});

export const providerUsage = z.object({
  providerId: z.string(),
  status: z.enum(["available", "unavailable", "error"]),
  planLabel: z.string().nullable(),
  windows: z.array(usageWindow),
  balances: z.array(usageBalance).optional(),
});

export type ProviderUsage = z.infer<typeof providerUsage>;

// `providers` is null when the daemon call rejected; `error` says why.
export const planUsageResult = z.object({
  providers: z.array(providerUsage).nullable(),
  error: z.string().nullable(),
});

export type PlanUsageResult = z.infer<typeof planUsageResult>;

// Every provider's plan usage from the daemon; the server handler is server/plan-usage.ts.
export const planUsageRpc = defineRpc({
  name: "orchestration.usage.plan",
  input: z.object({}),
  output: planUsageResult,
});

// The rows, in this order, whatever the daemon returns.
export const PLAN_PROVIDERS = [
  { id: "claude", name: "Claude" },
  { id: "kiro", name: "Kiro" },
  { id: "cursor", name: "Cursor" },
] as const;

export type PlanUsageTone = "default" | "warning" | "danger";

// One window or balance. Each phrase is null when there is nothing to show; the client joins them
// with " · ".
export type PlanUsageMeter = {
  label: string;
  percent: string | null;
  amount: string | null;
  resets: string | null;
  runsOut: string | null;
  tone: PlanUsageTone;
};

// "unavailable": the daemon gave no entry, a status other than "available", or no number at all.
export type PlanUsageRow =
  | {
      provider: string;
      name: string;
      state: "available";
      plan: string | null;
      meters: PlanUsageMeter[];
    }
  | { provider: string; name: string; state: "unavailable" };

const toneOf = (tone: z.infer<typeof usageTone> | undefined): PlanUsageTone =>
  tone === "warning" || tone === "danger" ? tone : "default";

// "4d 2h" from a day up, else "3h 54m", else "12m"; whole units, rounded down.
function duration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

const until = (iso: string | null | undefined, now: Date) =>
  iso ? duration(new Date(iso).getTime() - now.getTime()) : null;

function windowMeter(window: z.infer<typeof usageWindow>, now: Date): PlanUsageMeter {
  const resets = until(window.resetsAt, now);
  const runsOut = until(window.runsOutAt, now);
  return {
    label: window.label,
    percent: window.usedPct == null ? null : `${Math.round(window.usedPct)}%`,
    amount: null,
    resets: resets && `resets in ${resets}`,
    runsOut: runsOut && `runs out in ${runsOut}`,
    tone: toneOf(window.tone),
  };
}

// "$569.46", "$70" for usd; "1200 tokens" otherwise. Whole numbers drop the decimals.
function quantity(value: number, unit: z.infer<typeof usageBalance>["unit"]): string {
  const number = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return unit === "usd" ? `$${number}` : `${number} ${unit}`;
}

function balanceMeter(balance: z.infer<typeof usageBalance>, now: Date): PlanUsageMeter {
  const { used, limit, unit } = balance;
  const resets = until(balance.resetsAt, now);
  const amount =
    used == null ? null : limit == null ? quantity(used, unit) : `${quantity(used, unit)} of ${quantity(limit, unit)}`;
  return {
    label: balance.label,
    percent: used == null || !limit ? null : `${Math.round((used / limit) * 100)}%`,
    amount,
    resets: resets && `resets in ${resets}`,
    runsOut: null,
    tone: toneOf(balance.tone),
  };
}

// Exactly one row per PLAN_PROVIDERS entry, in that order; other providers are ignored.
export function planUsageRows(result: PlanUsageResult, now: Date): PlanUsageRow[] {
  return PLAN_PROVIDERS.map(({ id, name }): PlanUsageRow => {
    const usage = result.providers?.find((provider) => provider.providerId === id);
    const unavailable = { provider: id, name, state: "unavailable" as const };
    if (usage?.status !== "available") return unavailable;
    const meters = [
      ...usage.windows.map((window) => windowMeter(window, now)),
      ...(usage.balances ?? []).map((balance) => balanceMeter(balance, now)),
    ];
    if (!meters.some((meter) => meter.percent !== null || meter.amount !== null)) return unavailable;
    return { provider: id, name, state: "available", plan: usage.planLabel, meters };
  });
}
