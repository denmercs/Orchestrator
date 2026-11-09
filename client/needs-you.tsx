import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { contextSummaryRpc } from "../shared/context";
import type { Gate } from "../shared/gates";
import type { EpicBoard } from "../shared/orchestration";
import {
  PLAN_PROVIDERS,
  planUsageRows,
  planUsageRpc,
  type PlanUsageMeter,
  type PlanUsageResult,
} from "../shared/plan-usage";
import { budgetSettings } from "../shared/settings";
import { startOfDay, statsOf, type Budget, type Spend } from "../shared/stats-strip";

type Theme = PluginSurfaceProps["theme"];

const SPEND_POLL_MS = 60_000;
const DEFAULT_BUDGET: Budget = { dailyBudgetUsd: 25, storyCapUsd: 5 };

// Today's and this week's spend from the context summary, polled every minute from local midnight.
// Null until the first summary loads, and while it keeps failing.
function useSpend(): Spend | null {
  const load = useRpc(contextSummaryRpc);
  const [spend, setSpend] = useState<Spend | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      const today = startOfDay(new Date()).toISOString();
      load({ since: today, today })
        .then((summary) => {
          if (active) setSpend({ spendToday: summary.spendToday, spendWeek: summary.spendWeek });
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, SPEND_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [load]);

  return spend;
}

const PLAN_USAGE_POLL_MS = 60_000;

// Plan usage from the daemon (see CONTEXT.md, "Plan usage"), polled every minute. Null until the first
// call returns; a failed call keeps the last good result.
function usePlanUsage(): PlanUsageResult | null {
  const load = useRpc(planUsageRpc);
  const [usage, setUsage] = useState<PlanUsageResult | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      load({})
        .then((result) => {
          if (active) setUsage(result);
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, PLAN_USAGE_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [load]);

  return usage;
}

// A meter's non-null phrases: "Session 39% · resets in 3h 54m".
const meterText = (meter: PlanUsageMeter) =>
  [meter.label, meter.percent, meter.amount, meter.resets, meter.runsOut].filter(Boolean).join(" · ");

// The stats strip under the start input (see CONTEXT.md, "Stats strip"): five numbers from statsOf, then
// the plan usage lines.
export function StatsStrip({
  theme,
  compact,
  boards,
  gates,
}: {
  theme: Theme;
  compact: boolean;
  boards: EpicBoard[] | null;
  gates: Gate[];
}) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const settings = useSettings(budgetSettings);
  const spend = useSpend();
  const budget = settings.status === "ready" ? settings.values : DEFAULT_BUDGET;
  const stats = statsOf({ boards, gates, spend, budget });
  const planUsage = usePlanUsage();
  const planRows = planUsage ? planUsageRows(planUsage, new Date()) : null;

  return (
    <View style={styles.strip}>
      {stats.map((stat, index) => (
        <View key={stat.label} style={[styles.stat, index > 0 ? styles.statDivider : null]}>
          <View style={styles.statLabelRow}>
            <View style={[styles.dot, { backgroundColor: theme.colors[DOT[stat.label] ?? "foregroundMuted"] }]} />
            <Text style={styles.statLabel}>{stat.label}</Text>
          </View>
          <Text style={[styles.statValue, stat.tone === "warning" ? styles.warning : null]}>{stat.value}</Text>
          <Text style={styles.statSub} numberOfLines={1}>
            {stat.sub}
          </Text>
        </View>
      ))}
      <View style={styles.planUsage}>
        <Text style={styles.statLabel}>Plan usage</Text>
        {(planRows ?? PLAN_PROVIDERS.map(({ id, name }) => ({ provider: id, name, state: null }))).map((row) => (
          <Text key={row.provider} style={styles.planLine}>
            <Text style={styles.planName}>{row.name}</Text>
            {row.state === "available" ? (
              <>
                {row.plan ? <Text style={styles.statSub}>{` ${row.plan}`}</Text> : null}
                {row.meters.map((meter, index) => (
                  <Text
                    key={`${meter.label}-${index}`}
                    style={meter.tone === "danger" ? styles.danger : meter.tone === "warning" ? styles.warning : null}
                  >{`  ${meterText(meter)}`}</Text>
                ))}
              </>
            ) : (
              <Text style={styles.statSub}>{row.state === "unavailable" ? "  unavailable" : "  —"}</Text>
            )}
          </Text>
        ))}
      </View>
    </View>
  );
}

// The dot beside each stat's label, as in the design: green running, blue ready, amber gates.
const DOT: Record<string, keyof Theme["colors"]> = {
  Running: "statusSuccess",
  Ready: "accent",
  "Needs you": "statusWarning",
  Merged: "border",
  "Spend today": "foregroundMuted",
};

function createStyles(theme: Theme, compact: boolean) {
  const c = theme.colors;
  return {
    strip: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      backgroundColor: c.surface1,
      overflow: "hidden" as const,
    },
    stat: {
      minWidth: compact ? 120 : 150,
      flexGrow: 1,
      flexBasis: 0,
      gap: 4,
      paddingVertical: compact ? 10 : 14,
      paddingHorizontal: compact ? 12 : 18,
    },
    statDivider: { borderLeftWidth: 1, borderLeftColor: c.border },
    statLabelRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 7 },
    dot: { width: 7, height: 7, borderRadius: 3.5 },
    statLabel: { fontSize: 12, color: c.foregroundMuted },
    statValue: {
      fontSize: 22,
      fontWeight: "600" as const,
      fontVariant: ["tabular-nums" as const],
      color: c.foreground,
    },
    statSub: { fontSize: 11.5, color: c.foregroundMuted },
    warning: { color: c.statusWarning },
    danger: { color: c.statusDanger },
    planUsage: {
      width: "100%" as const,
      gap: 4,
      paddingVertical: compact ? 10 : 12,
      paddingHorizontal: compact ? 12 : 18,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    planLine: { fontSize: 12, color: c.foreground },
    planName: { fontWeight: "600" as const },
  };
}
