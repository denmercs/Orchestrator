import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { listOrchestrationParents, listOrchestrationSchedules } from "../shared/orchestration";
import {
  type BoardItem,
  type BoardModel,
  type ParentLink,
  type PhaseId,
  createBoardModel,
} from "./board-model";
import { StandupSection } from "./standup-section";
import { useOrchestrationCatalog } from "./use-orchestration-catalog";

export function OrchestrationDashboard({ theme, layout, navigation }: PluginSurfaceProps) {
  const { agents, workspaces, error, loading } = useOrchestrationCatalog();
  const listSchedules = useRpc(listOrchestrationSchedules);
  const listParents = useRpc(listOrchestrationParents);
  const [schedules, setSchedules] = useState<
    Awaited<ReturnType<typeof listSchedules>>["schedules"]
  >([]);
  const [parentLinks, setParentLinks] = useState<ParentLink[]>([]);
  const [selectedPhaseId, setSelectedPhaseId] = useState<PhaseId | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const agentIds = useMemo(
    () =>
      agents
        .filter((agent) => !agent.archivedAt && agent.status !== "closed")
        .map((agent) => agent.id)
        .sort()
        .join(","),
    [agents],
  );

  const refreshSchedules = useCallback(async () => {
    try {
      setSchedules((await listSchedules({})).schedules);
    } catch {
      setSchedules([]);
    }
  }, [listSchedules]);

  const refreshParents = useCallback(async () => {
    if (!agentIds) {
      setParentLinks([]);
      return;
    }
    try {
      setParentLinks((await listParents({ agentIds: agentIds.split(",") })).links);
    } catch {
      setParentLinks([]);
    }
  }, [agentIds, listParents]);

  useEffect(() => {
    void refreshSchedules();
  }, [refreshSchedules]);

  useEffect(() => {
    void refreshParents();
  }, [refreshParents]);

  const board = useMemo(
    () => createBoardModel(agents, workspaces, schedules, parentLinks),
    [agents, workspaces, schedules, parentLinks],
  );
  const selectedPhase =
    board.phases.find((phase) => phase.id === selectedPhaseId) ??
    board.phases.find((phase) => phase.items.length > 0) ??
    board.phases[0];
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);

  function toggleCollapsed(id: string) {
    setCollapsed((current) => ({ ...current, [id]: !current[id] }));
  }

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
          value={`${board.inProgress}/${board.total || 0}`}
          hint={`${board.total} active agents`}
          ratio={board.total ? board.inProgress / board.total : 0}
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

      <StandupSection theme={theme} layout={layout} />

      <View style={styles.sectionHead}>
        <Text style={styles.sectionLabel}>
          EPIC TREES · {board.families.length}
        </Text>
        {board.families.length > 1 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              board.families.every((family) => collapsed[family.epic.id])
                ? "Expand all epic trees"
                : "Collapse all epic trees"
            }
            onPress={() => {
              const hide = !board.families.every((family) => collapsed[family.epic.id]);
              setCollapsed((current) => ({
                ...current,
                ...Object.fromEntries(board.families.map((family) => [family.epic.id, hide])),
              }));
            }}
          >
            <Text style={styles.sectionToggle}>
              {board.families.every((family) => collapsed[family.epic.id])
                ? "Expand all"
                : "Collapse all"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.sectionHint}>
        Children sit under the epic that spawned them. Tap the count to hide or show them.
      </Text>
      {board.families.length === 0 ? (
        <Text style={styles.muted}>No epic orchestrations on the board.</Text>
      ) : (
        board.families.map((family) => {
          const hidden = Boolean(collapsed[family.epic.id]);
          const childCount = family.children.length;
          return (
            <View key={family.epic.id} style={styles.familyCard}>
              <View style={styles.familyHead}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: !hidden }}
                  accessibilityLabel={
                    hidden
                      ? `Expand ${childCount} children`
                      : `Collapse ${childCount} children`
                  }
                  onPress={() => toggleCollapsed(family.epic.id)}
                  style={styles.familyToggle}
                >
                  <Text style={styles.familyToggleText}>
                    {hidden ? "▸" : "▾"} {childCount} {childCount === 1 ? "child" : "children"}
                  </Text>
                </Pressable>
              </View>
              <SessionCard item={family.epic} styles={styles} onOpen={openItem} />
              {hidden ? null : childCount === 0 ? (
                <Text style={styles.muted}>No live children.</Text>
              ) : (
                family.children.map((child) => (
                  <SessionCard
                    key={child.id}
                    item={child}
                    nested
                    styles={styles}
                    onOpen={openItem}
                  />
                ))
              )}
            </View>
          );
        })
      )}

      <View style={styles.sectionHead}>
        <Text style={styles.sectionLabel}>STORIES · {board.stories.length}</Text>
        {board.stories.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: !collapsed.stories }}
            accessibilityLabel={collapsed.stories ? "Expand stories" : "Collapse stories"}
            onPress={() => toggleCollapsed("stories")}
          >
            <Text style={styles.sectionToggle}>{collapsed.stories ? "Expand" : "Collapse"}</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.sectionHint}>Standalone sessions — not under an epic.</Text>
      {board.stories.length === 0 ? (
        <Text style={styles.muted}>No standalone stories.</Text>
      ) : collapsed.stories ? (
        <Text style={styles.muted}>{board.stories.length} hidden.</Text>
      ) : (
        board.stories.map((item) => (
          <SessionCard key={item.id} item={item} styles={styles} onOpen={openItem} />
        ))
      )}

      <Text style={styles.sectionLabel}>WAITING ON YOU · {board.waitingOnYou.length} items</Text>
      {board.waitingOnYou.length === 0 ? (
        <Text style={styles.muted}>Nothing waiting on you.</Text>
      ) : (
        board.waitingOnYou.map((item) => (
          <View key={item.id} style={styles.waitRow}>
            <View style={styles.waitMain}>
              <View style={styles.waitTitleRow}>
                <View style={[styles.dot, { backgroundColor: theme.colors.statusDanger }]} />
                <RoleTag role={item.role} styles={styles} />
                {item.key ? <Text style={styles.waitKey}>{item.key}</Text> : null}
                <Text style={styles.waitTitle}>
                  {item.title.startsWith("Blocked") ? item.title : `Blocked — ${item.title}`}
                </Text>
              </View>
              {item.underTitle ? (
                <Text style={styles.underLine}>Under {item.underTitle}</Text>
              ) : null}
              <Text style={styles.waitDetail}>{item.detail}</Text>
            </View>
            {item.retryLabel ? (
              <Pill label={item.retryLabel} styles={styles} onPress={() => openItem(item)} />
            ) : null}
          </View>
        ))
      )}

      <Text style={styles.sectionLabel}>SESSIONS BY STATUS</Text>
      <Text style={styles.sectionHint}>
        Live agent status — tap a column to see those sessions.
      </Text>
      <View style={styles.phaseColumns}>
        {board.phases.map((phase) => {
          const selected = phase.id === selectedPhase?.id;
          const count = phase.items.length;
          return (
            <Pressable
              key={phase.id}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`${phase.label}, ${count} ${count === 1 ? "session" : "sessions"}. ${phase.hint}`}
              onPress={() => setSelectedPhaseId(phase.id)}
              style={[styles.phaseCol, selected ? styles.phaseColSelected : null]}
            >
              <View style={[styles.phaseHalo, selected ? styles.phaseHaloSelected : null]}>
                <View
                  style={[
                    styles.phaseInner,
                    selected || count > 0 ? { backgroundColor: theme.colors.accent } : null,
                  ]}
                />
              </View>
              <Text style={[styles.phaseLabel, selected ? styles.phaseLabelSelected : null]}>
                {phase.label}
              </Text>
              <Text style={[styles.phaseCount, selected ? styles.phaseCountSelected : null]}>
                {count}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {selectedPhase ? (
        <View style={styles.phaseList}>
          <Text style={styles.phaseListHint}>{selectedPhase.hint}</Text>
          {selectedPhase.items.length === 0 ? (
            <Text style={styles.muted}>No sessions in this status.</Text>
          ) : (
            selectedPhase.items.map((item) => (
              <SessionCard key={item.id} item={item} styles={styles} onOpen={openItem} />
            ))
          )}
        </View>
      ) : null}

      <View style={styles.phaseBoard}>
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
                  <View style={styles.blockedHeadLeft}>
                    <RoleTag role={item.role} styles={styles} />
                    {item.key ? <Text style={styles.blockedKey}>{item.key}</Text> : null}
                  </View>
                  {item.pr ? <Text style={styles.pr}>#{item.pr}</Text> : null}
                </View>
                <Text style={styles.blockedTitle}>{item.title}</Text>
                {item.underTitle ? (
                  <Text style={styles.underLine}>Under {item.underTitle}</Text>
                ) : null}
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
                {item.retryLabel ? (
                  <View style={styles.blockedActions}>
                    <Pill label={item.retryLabel} styles={styles} onPress={() => openItem(item)} />
                  </View>
                ) : null}
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

function SessionCard({
  item,
  nested,
  styles,
  onOpen,
}: {
  item: BoardItem;
  nested?: boolean;
  styles: ReturnType<typeof createStyles>;
  onOpen: (item: BoardItem) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.role} ${item.title}`}
      onPress={() => onOpen(item)}
      style={[styles.phaseItem, nested ? styles.childItem : null]}
    >
      <View style={styles.waitTitleRow}>
        <RoleTag role={item.role} styles={styles} />
        <Text style={styles.phaseChip}>{item.phaseLabel}</Text>
        {item.key ? <Text style={styles.waitKey}>{item.key}</Text> : null}
        <Text style={styles.waitTitle} numberOfLines={2}>
          {item.title}
        </Text>
      </View>
      {item.underTitle ? <Text style={styles.underLine}>Under {item.underTitle}</Text> : null}
      <Text style={styles.waitDetail}>{item.detail}</Text>
      {item.retryLabel ? <Pill label={item.retryLabel} styles={styles} onPress={() => onOpen(item)} /> : null}
    </Pressable>
  );
}

function RoleTag({
  role,
  styles,
}: {
  role: BoardItem["role"];
  styles: ReturnType<typeof createStyles>;
}) {
  const look =
    role === "epic" ? "epic" : role === "story" ? "story" : "child";
  const label = role === "epic" ? "Epic" : role === "story" ? "Story" : "Child";
  return (
    <View
      style={
        look === "epic" ? styles.tagEpic : look === "story" ? styles.tagStory : styles.tagChild
      }
    >
      <Text
        style={
          look === "epic"
            ? styles.tagEpicText
            : look === "story"
              ? styles.tagStoryText
              : styles.tagChildText
        }
      >
        {label}
      </Text>
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
    sectionHead: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
    },
    sectionLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      letterSpacing: 0.8,
      marginTop: 8,
    },
    sectionToggle: {
      color: theme.colors.accent,
      fontSize: 12,
    },
    familyHead: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
    },
    familyToggle: {
      alignSelf: "flex-start" as const,
      paddingVertical: 2,
    },
    familyToggleText: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    sectionHint: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
      marginTop: -8,
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
      width: compact ? 88 : 108,
      alignItems: "center" as const,
      gap: 6,
      paddingVertical: 8,
      paddingHorizontal: 4,
      borderRadius: 12,
    },
    phaseColSelected: {
      backgroundColor: theme.colors.surface1,
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
    phaseHaloSelected: {
      borderStyle: "solid" as const,
      borderColor: theme.colors.accent,
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
    phaseLabelSelected: {
      color: theme.colors.foreground,
    },
    phaseCount: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    phaseCountSelected: {
      color: theme.colors.foreground,
      fontWeight: "600" as const,
    },
    phaseList: {
      gap: 8,
      width: "100%" as const,
    },
    phaseListHint: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    phaseItem: {
      gap: 6,
      paddingVertical: 12,
      paddingHorizontal: compact ? 12 : 16,
      borderRadius: 12,
      backgroundColor: theme.colors.surface1,
      borderColor: theme.colors.border,
      borderWidth: 1,
    },
    familyCard: {
      gap: 8,
      padding: compact ? 10 : 12,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    },
    childItem: {
      marginLeft: compact ? 12 : 20,
      borderStyle: "dashed" as const,
    },
    phaseChip: {
      color: theme.colors.foregroundMuted,
      fontSize: 10,
      letterSpacing: 0.3,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.colors.border,
      overflow: "hidden" as const,
    },
    underLine: {
      color: theme.colors.accent,
      fontSize: 12,
      marginLeft: compact ? 0 : 16,
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
      alignItems: "center" as const,
    },
    blockedHeadLeft: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      flexShrink: 1,
    },
    tagStory: {
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: 999,
      backgroundColor: theme.colors.surface2,
    },
    tagStoryText: {
      color: theme.colors.foreground,
      fontSize: 10,
      fontWeight: "600" as const,
      letterSpacing: 0.3,
    },
    tagEpic: {
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: 999,
      backgroundColor: theme.colors.accent,
    },
    tagEpicText: {
      color: theme.colors.accentForeground,
      fontSize: 10,
      fontWeight: "600" as const,
      letterSpacing: 0.3,
    },
    tagChild: {
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    },
    tagChildText: {
      color: theme.colors.foregroundMuted,
      fontSize: 10,
      fontWeight: "600" as const,
      letterSpacing: 0.3,
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
