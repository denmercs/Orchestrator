import { useMemo, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { TABS, type TabId } from "../shared/dashboard-tabs";

type Theme = PluginSurfaceProps["theme"];

// The fixed top of the dashboard: title, then the actions row passed as children.
export function DashboardHeader({
  theme,
  compact,
  children,
}: {
  theme: Theme;
  compact: boolean;
  children?: ReactNode;
}) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  return (
    <View style={styles.header}>
      <Text style={styles.title}>Orchestration</Text>
      {children ? <View style={styles.actions}>{children}</View> : null}
    </View>
  );
}

export function TabBar({
  theme,
  compact,
  active,
  counts,
  onSelect,
}: {
  theme: Theme;
  compact: boolean;
  active: TabId;
  counts: Record<TabId, number | null>;
  onSelect(tab: TabId): void;
}) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const tabs = TABS.map((tab) => {
    const selected = tab.id === active;
    const count = counts[tab.id];
    return (
      <Pressable
        key={tab.id}
        accessibilityRole="tab"
        accessibilityState={{ selected }}
        onPress={() => onSelect(tab.id)}
        style={[styles.tab, selected ? styles.tabActive : null]}
      >
        <Text style={selected ? styles.tabLabelActive : styles.tabLabel}>{tab.label}</Text>
        {count !== null ? (
          <View style={styles.pill}>
            <Text style={styles.pillText}>{count}</Text>
          </View>
        ) : null}
      </Pressable>
    );
  });

  // Five tabs don't fit a narrow surface, so the row scrolls sideways there.
  return compact ? (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.bar} contentContainerStyle={styles.row}>
      {tabs}
    </ScrollView>
  ) : (
    <View style={[styles.bar, styles.row]}>{tabs}</View>
  );
}

function createStyles(theme: Theme, compact: boolean) {
  const pad = compact ? 16 : 28;
  return {
    header: {
      // Keeps the runner and board menus above the tab body.
      zIndex: 10,
      paddingHorizontal: pad,
      paddingTop: pad,
      paddingBottom: 12,
      gap: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    },
    title: {
      color: theme.colors.foreground,
      fontSize: 20,
      fontWeight: "600" as const,
    },
    actions: {
      flexDirection: compact ? ("column" as const) : ("row" as const),
      alignItems: compact ? ("stretch" as const) : ("flex-start" as const),
      flexWrap: "wrap" as const,
      gap: 8,
    },
    bar: {
      flexGrow: 0,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    },
    row: {
      flexDirection: "row" as const,
      paddingHorizontal: pad,
      gap: compact ? 12 : 20,
    },
    tab: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
      paddingVertical: 10,
      borderBottomWidth: 2,
      borderBottomColor: "transparent",
    },
    tabActive: {
      borderBottomColor: theme.colors.foreground,
    },
    tabLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: 14,
    },
    tabLabelActive: {
      color: theme.colors.foreground,
      fontSize: 14,
      fontWeight: "600" as const,
    },
    pill: {
      minWidth: 20,
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: 999,
      alignItems: "center" as const,
      backgroundColor: theme.colors.surface2,
    },
    pillText: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
    },
  };
}
