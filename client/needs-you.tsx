import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { contextSummaryRpc } from "../shared/context";
import { gateAct, gateRow, type Gate, type GateRowAction } from "../shared/gates";
import type { EpicBoard } from "../shared/orchestration";
import { budgetSettings } from "../shared/settings";
import { startOfDay, statsOf, type Budget, type Spend } from "../shared/stats-strip";

type Theme = PluginSurfaceProps["theme"];

const rowKey = (gate: Gate) => `${gate.board}\n${gate.storyId}`;

// The needs-you queue at the top of the Initiatives tab: every gate, with the actions you can take on
// it (d6). One action runs at a time per row; the row's buttons stay disabled until the boards have
// re-read after it, so an acted-on gate can't be sent twice before it leaves the queue.
export function NeedsYouQueue({
  theme,
  compact,
  gates,
  navigation,
  onActed,
}: {
  theme: Theme;
  compact: boolean;
  gates: Gate[];
  navigation: PluginSurfaceProps["navigation"];
  onActed(): Promise<void>;
}) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const act = useRpc(gateAct);
  const toast = useToast();
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());

  function setRowBusy(key: string, on: boolean) {
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  async function run(gate: Gate, action: GateRowAction) {
    if (action.kind === "open-pr") {
      if (action.url) void openExternalUrl(action.url);
      else toast.error("No PR to open");
      return;
    }
    const key = rowKey(gate);
    if (busy.has(key)) return;
    setRowBusy(key, true);
    try {
      const result = await act({ board: gate.board, storyId: gate.storyId, action: action.kind });
      if (!result.ok) {
        toast.error(result.error ?? "Could not act on the gate.");
        return;
      }
      if (action.kind === "changes") {
        if (result.agentId && navigation) navigation.openAgent({ agentId: result.agentId });
        else toast.show("No session to open");
      }
      await onActed();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not act on the gate.");
    } finally {
      setRowBusy(key, false);
    }
  }

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.chip}>
          <Text style={styles.chipText}>{`NEEDS YOU · ${gates.length}`}</Text>
        </View>
        <Text style={styles.headerText}>Agents are paused at these gates</Text>
      </View>
      {gates.map((gate) => {
        const key = rowKey(gate);
        const row = gateRow(gate);
        const disabled = busy.has(key);
        return (
          <View key={key} style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.text}>
                <Text style={styles.tag}>{row.tag}</Text> {row.text}
              </Text>
              <Text style={styles.where}>{row.where}</Text>
            </View>
            <View style={styles.buttons}>
              {row.secondary ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${row.secondary.label}, ${row.tag}`}
                  disabled={disabled}
                  onPress={() => row.secondary && void run(gate, row.secondary)}
                  style={[styles.button, styles.secondary, disabled ? styles.disabled : null]}
                >
                  <Text style={styles.secondaryText}>{row.secondary.label}</Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${row.primary.label}, ${row.tag}`}
                disabled={disabled}
                onPress={() => void run(gate, row.primary)}
                style={[styles.button, styles.primary, disabled ? styles.disabled : null]}
              >
                <Text style={styles.primaryText}>{row.primary.label}</Text>
              </Pressable>
            </View>
          </View>
        );
      })}
    </View>
  );
}

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

// The stats strip under the queue (see CONTEXT.md, "Stats strip"): five numbers from statsOf.
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
    card: {
      borderWidth: 1,
      borderColor: c.statusWarning,
      borderRadius: 10,
      backgroundColor: c.surface1,
      overflow: "hidden" as const,
      marginBottom: 12,
    },
    header: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      flexWrap: "wrap" as const,
      gap: 10,
      paddingVertical: 10,
      paddingHorizontal: compact ? 12 : 16,
    },
    chip: { paddingVertical: 2, paddingHorizontal: 7, borderRadius: 4, backgroundColor: c.statusWarning },
    chipText: { fontSize: 10.5, fontWeight: "600" as const, letterSpacing: 0.2, color: c.surface0 },
    headerText: { fontSize: 11.5, color: c.foregroundMuted },
    row: {
      flexDirection: compact ? ("column" as const) : ("row" as const),
      alignItems: compact ? ("stretch" as const) : ("center" as const),
      gap: compact ? 8 : 12,
      paddingVertical: 10,
      paddingHorizontal: compact ? 12 : 16,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    rowText: { flex: compact ? undefined : 1, minWidth: 0, gap: 2 },
    text: { fontSize: 12.5, color: c.foreground },
    tag: { fontFamily: "monospace", color: c.statusWarning },
    where: { fontSize: 11.5, color: c.foregroundMuted },
    buttons: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
    button: {
      height: 26,
      paddingHorizontal: 12,
      borderRadius: 6,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    primary: { backgroundColor: c.statusWarning },
    primaryText: { fontSize: 12, fontWeight: "600" as const, color: c.surface0 },
    secondary: { borderWidth: 1, borderColor: c.border, backgroundColor: "transparent" },
    secondaryText: { fontSize: 12, color: c.foreground },
    disabled: { opacity: 0.5 },
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
  };
}
