import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { contextSummaryRpc, type ContextSummary } from "../shared/context";
import { summaryTiles } from "./context-pill-model";

const CARD_POLL_MS = 60_000;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// The dashboard's context card (see CONTEXT.md, "Context card"): telemetry totals for the last 7 days.
export function ContextCard({ theme }: { theme: PluginSurfaceProps["theme"] }) {
  const load = useRpc(contextSummaryRpc);
  const [summary, setSummary] = useState<ContextSummary | null>(null);
  const styles = useMemo(() => createStyles(theme), [theme]);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      load({ since: new Date(Date.now() - WINDOW_MS).toISOString() })
        .then((next) => {
          if (active) setSummary(next);
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, CARD_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [load]);

  if (!summary) return null;
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>CONTEXT · last 7 days</Text>
      <View style={styles.tiles}>
        {summaryTiles(summary).map((tile) => (
          <View key={tile.label} style={styles.tile}>
            <Text style={styles.value}>{tile.value}</Text>
            <Text style={styles.label}>{tile.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function createStyles(theme: PluginSurfaceProps["theme"]) {
  return {
    card: {
      gap: 8,
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
      borderRadius: 8,
    },
    heading: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      fontWeight: "600" as const,
    },
    tiles: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: 16,
    },
    tile: {
      gap: 2,
    },
    value: {
      color: theme.colors.foreground,
      fontSize: 15,
      fontWeight: "600" as const,
    },
    label: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
    },
  };
}
