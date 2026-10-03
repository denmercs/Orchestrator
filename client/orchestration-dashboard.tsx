import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { listOrchestrationSchedules } from "../shared/orchestration";
import { type BoardItem, type BoardModel, createBoardModel } from "./board-model";
import { useOrchestrationCatalog } from "./use-orchestration-catalog";

export function OrchestrationDashboard({ theme, layout, navigation }: PluginSurfaceProps) {
  const { agents, workspaces, error, loading } = useOrchestrationCatalog();
  const listSchedules = useRpc(listOrchestrationSchedules);
  const [schedules, setSchedules] = useState<
    Awaited<ReturnType<typeof listSchedules>>["schedules"]
  >([]);

  const refreshSchedules = useCallback(async () => {
    try {
      setSchedules((await listSchedules({})).schedules);
    } catch {
      setSchedules([]);
    }
  }, [listSchedules]);

  useEffect(() => {
    void refreshSchedules();
  }, [refreshSchedules]);

  const board = useMemo(
    () => createBoardModel(agents, workspaces, schedules),
    [agents, workspaces, schedules],
  );
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);

  function openItem(item: BoardItem) {
    if (item.agentId && navigation) {
      navigation.openAgent({ agentId: item.agentId });
      return;
    }
    if (item.workspaceId && navigation) {
      navigation.openWorkspace({ workspaceId: item.workspaceId });
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>{board.title}</Text>
      <View style={styles.metaRow}>
        <View style={[styles.dot, { backgroundColor: loopColor(board.loopStatus, theme) }]} />
        <Text style={styles.meta}>
          Loop {board.loopStatus}
          {"  ·  "}
          Next: {board.nextLabel}
          {"  ·  "}
          {board.blockedSummary}
          {"  ·  "}
          Updated {board.updatedAt}
        </Text>
      </View>

      {loading ? <Text style={styles.muted}>Loading live catalog…</Text> : null}
      {error ? <Text style={styles.danger}>{error}</Text> : null}

      <View style={styles.stats}>
        <ProgressStat
          label="PROGRESS"
          value={`${board.mergedCount}/${board.total || 0}`}
          hint={`${percent(board.mergedCount, board.total)}% merged`}
          ratio={board.total ? board.mergedCount / board.total : 0}
          styles={styles}
          theme={theme}
        />
        <CountStat label="IN PROGRESS" value={board.inProgress} hint="running" styles={styles} />
        <CountStat
          label="READY TO START"
          value={board.readyToStart}
          hint="waiting on dependencies"
          styles={styles}
        />
        <CountStat
          label="BLOCKED"
          value={board.blockedCount}
          hint="for the loop"
          valueColor={theme.colors.statusDanger}
          styles={styles}
        />
      </View>

      <Text style={styles.sectionLabel}>WAITING ON YOU · {board.waitingOnYou.length} items</Text>
      {board.waitingOnYou.length === 0 ? (
        <Text style={styles.muted}>Nothing waiting on you.</Text>
      ) : (
        board.waitingOnYou.map((item) => (
          <View key={item.id} style={styles.waitRow}>
            <View style={styles.waitMain}>
              <View style={styles.waitTitleRow}>
                <View style={[styles.dot, { backgroundColor: theme.colors.statusDanger }]} />
                <Text style={styles.waitKey}>{item.key}</Text>
                <Text style={styles.waitTitle}>
                  {item.title.startsWith("Blocked") ? item.title : `Blocked — ${item.title}`}
                </Text>
              </View>
              <Text style={styles.waitDetail}>{item.detail}</Text>
            </View>
            {item.retryLabel ? (
              <Pill label={item.retryLabel} styles={styles} onPress={() => openItem(item)} />
            ) : null}
          </View>
        ))
      )}

      <Text style={styles.sectionLabel}>PHASE BOARD</Text>
      <View style={styles.phaseBoard}>
        <View style={styles.phaseColumns}>
          {board.phases.map((phase) => (
            <View key={phase.id} style={styles.phaseCol}>
              <View style={styles.phaseHalo}>
                <View style={styles.phaseInner} />
              </View>
              <Text style={styles.phaseLabel}>{phase.label}</Text>
              <Text style={styles.phaseCount}>{phase.count}</Text>
            </View>
          ))}
        </View>

        <View style={styles.mergedCol}>
          <View style={styles.colHead}>
            <View style={[styles.dot, { backgroundColor: theme.colors.statusSuccess }]} />
            <Text style={styles.colTitle}>Merged</Text>
            <Text style={styles.colCount}>{board.mergedCount}</Text>
          </View>
          {board.merged.length === 0 ? (
            <Text style={styles.muted}>No merged items.</Text>
          ) : (
            board.merged.map((item) => (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityLabel={`${item.key} ${item.title}`}
                onPress={() => openItem(item)}
                style={styles.mergedRow}
              >
                <Text style={styles.mergedKey}>{item.key}</Text>
                <Text style={styles.mergedTitle} numberOfLines={1}>
                  {item.title}
                </Text>
                {item.pr ? <Text style={styles.pr}>#{item.pr}</Text> : null}
              </Pressable>
            ))
          )}
        </View>

        <View style={styles.blockedCol}>
          <View style={styles.colHead}>
            <View style={[styles.dot, { backgroundColor: theme.colors.statusDanger }]} />
            <Text style={styles.colTitle}>Blocked</Text>
            <Text style={styles.colCount}>{board.blockedCount}</Text>
          </View>
          {board.blocked.length === 0 ? (
            <Text style={styles.muted}>No blocked items.</Text>
          ) : (
            board.blocked.map((item) => (
              <View key={item.id} style={styles.blockedCard}>
                <View style={styles.blockedHead}>
                  <Text style={styles.blockedKey}>{item.key}</Text>
                  {item.pr ? <Text style={styles.pr}>#{item.pr}</Text> : null}
                </View>
                <Text style={styles.blockedTitle}>{item.title}</Text>
                <Text style={styles.waitDetail}>{item.detail}</Text>
                {item.progress !== null ? (
                  <View style={styles.barTrack}>
                    <View
                      style={[
                        styles.barFill,
                        {
                          width: `${Math.round(item.progress * 100)}%`,
                          backgroundColor: theme.colors.statusDanger,
                        },
                      ]}
                    />
                  </View>
                ) : null}
                <View style={styles.blockedActions}>
                  <Pill label="Open session" styles={styles} onPress={() => openItem(item)} />
                  {item.retryLabel ? (
                    <Pill label={item.retryLabel} styles={styles} onPress={() => openItem(item)} />
                  ) : null}
                </View>
              </View>
            ))
          )}
        </View>
      </View>
    </ScrollView>
  );
}

function ProgressStat({
  label,
  value,
  hint,
  ratio,
  styles,
  theme,
}: {
  label: string;
  value: string;
  hint: string;
  ratio: number;
  styles: ReturnType<typeof createStyles>;
  theme: PluginSurfaceProps["theme"];
}) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
      <View style={styles.barTrack}>
        <View
          style={[
            styles.barFill,
            {
              width: `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`,
              backgroundColor: theme.colors.statusSuccess,
            },
          ]}
        />
      </View>
      <Text style={styles.statHint}>{hint}</Text>
    </View>
  );
}

function CountStat({
  label,
  value,
  hint,
  valueColor,
  styles,
}: {
  label: string;
  value: number;
  hint: string;
  valueColor?: string;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, valueColor ? { color: valueColor } : null]}>{value}</Text>
      <Text style={styles.statHint}>{hint}</Text>
    </View>
  );
}

function Pill({
  label,
  styles,
  onPress,
}: {
  label: string;
  styles: ReturnType<typeof createStyles>;
  onPress: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.pill}>
      <Text style={styles.pillText}>{label}</Text>
    </Pressable>
  );
}

function loopColor(status: BoardModel["loopStatus"], theme: PluginSurfaceProps["theme"]) {
  return status === "running" ? theme.colors.statusSuccess : theme.colors.foregroundMuted;
}

function percent(part: number, total: number) {
  if (!total) {
    return 0;
  }
  return Math.round((part / total) * 100);
}

function createStyles(theme: PluginSurfaceProps["theme"], compact: boolean) {
  const pad = compact ? 16 : 28;
  return {
    screen: {
      flex: 1,
      backgroundColor: theme.colors.surface0,
    },
    content: {
      padding: pad,
      gap: compact ? 14 : 18,
    },
    title: {
      color: theme.colors.foreground,
      fontSize: compact ? 22 : 28,
      fontWeight: "600" as const,
    },
    metaRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
    },
    meta: {
      color: theme.colors.foregroundMuted,
      flex: 1,
    },
    dot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    stats: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: compact ? 10 : 16,
      paddingVertical: 8,
      borderTopWidth: 1,
      borderBottomWidth: 1,
      borderColor: theme.colors.border,
    },
    stat: {
      minWidth: compact ? 120 : 160,
      flexGrow: 1,
      gap: 4,
    },
    statLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      letterSpacing: 0.6,
    },
    statValue: {
      color: theme.colors.foreground,
      fontSize: compact ? 22 : 28,
      fontWeight: "500" as const,
    },
    statHint: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    barTrack: {
      height: 3,
      borderRadius: 2,
      backgroundColor: theme.colors.surface2,
      overflow: "hidden" as const,
    },
    barFill: {
      height: 3,
      borderRadius: 2,
    },
    sectionLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      letterSpacing: 0.8,
      marginTop: 8,
    },
    waitRow: {
      flexDirection: compact ? ("column" as const) : ("row" as const),
      alignItems: compact ? ("stretch" as const) : ("center" as const),
      justifyContent: "space-between" as const,
      gap: 12,
      paddingVertical: 14,
      paddingHorizontal: compact ? 12 : 16,
      borderRadius: 12,
      backgroundColor: theme.colors.surface1,
      borderColor: theme.colors.border,
      borderWidth: 1,
    },
    waitMain: {
      flex: 1,
      gap: 4,
    },
    waitTitleRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      flexWrap: "wrap" as const,
    },
    waitKey: {
      color: theme.colors.foregroundMuted,
    },
    waitTitle: {
      color: theme.colors.foreground,
      flexShrink: 1,
    },
    waitDetail: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
      marginLeft: compact ? 0 : 16,
    },
    pill: {
      alignSelf: "flex-start" as const,
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    },
    pillText: {
      color: theme.colors.foreground,
      fontSize: 12,
    },
    phaseBoard: {
      flexDirection: compact ? ("column" as const) : ("row" as const),
      gap: compact ? 16 : 20,
      alignItems: "flex-start" as const,
    },
    phaseColumns: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: compact ? 10 : 14,
    },
    phaseCol: {
      width: compact ? 72 : 84,
      alignItems: "center" as const,
      gap: 6,
    },
    phaseHalo: {
      width: 28,
      height: 28,
      borderRadius: 14,
      borderWidth: 1,
      borderStyle: "dashed" as const,
      borderColor: theme.colors.border,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    phaseInner: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: theme.colors.surface2,
    },
    phaseLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      textAlign: "center" as const,
    },
    phaseCount: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    mergedCol: {
      flex: 1,
      minWidth: compact ? undefined : 240,
      alignSelf: compact ? ("stretch" as const) : undefined,
      gap: 8,
    },
    blockedCol: {
      flex: 1,
      minWidth: compact ? undefined : 260,
      alignSelf: compact ? ("stretch" as const) : undefined,
      gap: 10,
    },
    colHead: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
    },
    colTitle: {
      color: theme.colors.foreground,
      fontWeight: "500" as const,
    },
    colCount: {
      color: theme.colors.foregroundMuted,
    },
    mergedRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 10,
      paddingVertical: 6,
    },
    mergedKey: {
      color: theme.colors.foregroundMuted,
      minWidth: 56,
    },
    mergedTitle: {
      color: theme.colors.foreground,
      flex: 1,
    },
    pr: {
      color: theme.colors.foregroundMuted,
    },
    blockedCard: {
      gap: 8,
      padding: 14,
      borderRadius: 12,
      backgroundColor: theme.colors.surface1,
      borderColor: theme.colors.border,
      borderWidth: 1,
    },
    blockedHead: {
      flexDirection: "row" as const,
      justifyContent: "space-between" as const,
    },
    blockedKey: {
      color: theme.colors.foregroundMuted,
    },
    blockedTitle: {
      color: theme.colors.foreground,
      fontSize: 16,
    },
    blockedActions: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: 8,
      marginTop: 4,
    },
    muted: {
      color: theme.colors.foregroundMuted,
    },
    danger: {
      color: theme.colors.statusDanger,
    },
  };
}
