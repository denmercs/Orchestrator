import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { openExternalUrl, usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import {
  getJiraBoard,
  listJiraBoards,
  listJiraPullRequests,
  listOrchestrationParents,
  listOrchestrationSchedules,
  type JiraBoardColumn,
  type JiraBoardOption,
  type JiraIssue,
  type JiraPullRequest,
  type JiraSprint,
} from "../shared/orchestration";
import { jiraBoardSettings } from "../shared/settings";
import { PR_POLL_MS } from "../shared/timing";
import {
  type BoardItem,
  type BoardModel,
  type JiraColumnGroup,
  type ParentLink,
  createBoardModel,
  groupJiraColumns,
} from "./board-model";
import { ProdPulseButton, ProdPulseDrawer, useProdPulse } from "./prod-pulse-drawer";
import { startJiraSession } from "./start-jira-session";
import { StandupSection } from "./standup-section";
import { useOrchestrationCatalog } from "./use-orchestration-catalog";

export function OrchestrationDashboard({ theme, layout, navigation }: PluginSurfaceProps) {
  const paseo = usePaseo();
  const { agents, workspaces, error, loading } = useOrchestrationCatalog();
  const listSchedules = useRpc(listOrchestrationSchedules);
  const listParents = useRpc(listOrchestrationParents);
  const loadJiraBoard = useRpc(getJiraBoard);
  const loadJiraBoards = useRpc(listJiraBoards);
  const loadJiraPrs = useRpc(listJiraPullRequests);
  const boardSettings = useSettings(jiraBoardSettings);
  const defaultBoardId = boardSettings.status === "ready" ? boardSettings.values.defaultBoardId : "";
  const boardFilter = boardSettings.status === "ready" ? boardSettings.values.boardFilter : null;
  const [schedules, setSchedules] = useState<
    Awaited<ReturnType<typeof listSchedules>>["schedules"]
  >([]);
  const [parentLinks, setParentLinks] = useState<ParentLink[]>([]);
  const [jiraBoards, setJiraBoards] = useState<JiraBoardOption[]>([]);
  const [selectedBoardId, setSelectedBoardId] = useState("1");
  const [boardMenuOpen, setBoardMenuOpen] = useState(false);
  const [jiraIssues, setJiraIssues] = useState<JiraIssue[]>([]);
  const [jiraColumns, setJiraColumns] = useState<JiraBoardColumn[]>([]);
  const [jiraSprint, setJiraSprint] = useState<JiraSprint | null>(null);
  const [selectedJiraColumn, setSelectedJiraColumn] = useState<string | null>(null);
  const [jiraPrs, setJiraPrs] = useState<JiraPullRequest[]>([]);
  const [jiraError, setJiraError] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selectedLaneId, setSelectedLaneId] = useState<string | null>(null);
  const { pulse, refresh: refreshPulse } = useProdPulse();
  const [pulseOpen, setPulseOpen] = useState(false);
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

  const refreshJiraBoards = useCallback(async () => {
    try {
      const result = await loadJiraBoards({});
      setJiraBoards(result.boards);
      if (result.error) {
        setJiraError(result.error);
      }
      setSelectedBoardId((current) => {
        if (result.boards.some((board) => board.id === current)) {
          return current;
        }
        const quickpress = result.boards.find((board) =>
          board.name.toLowerCase().includes("quickpress"),
        );
        return quickpress?.id ?? result.boards[0]?.id ?? current;
      });
    } catch (cause) {
      setJiraBoards([]);
      setJiraError(cause instanceof Error ? cause.message : "Unable to list Jira boards");
    }
    // boardFilter is applied on the host; refetch when it changes.
  }, [loadJiraBoards, boardFilter]);

  const saveBoardFilter = useCallback(
    async (next: string) => {
      if (boardSettings.status !== "ready" || next === boardSettings.values.boardFilter) {
        return;
      }
      const saved = await boardSettings.save(
        { ...boardSettings.values, boardFilter: next },
        boardSettings.revision,
      );
      if (!saved) {
        setJiraError(boardSettings.saveError ?? "Could not save board filter.");
      }
    },
    [boardSettings],
  );

  const defaultDeveloper =
    boardSettings.status === "ready" ? boardSettings.values.developer : "";
  const saveDefaultDeveloper = useCallback(
    async (next: string) => {
      if (boardSettings.status !== "ready" || next === boardSettings.values.developer) {
        return;
      }
      const saved = await boardSettings.save(
        { ...boardSettings.values, developer: next },
        boardSettings.revision,
      );
      if (!saved) {
        setJiraError(boardSettings.saveError ?? "Could not save the default developer.");
      }
    },
    [boardSettings],
  );

  // The last board picked is the default; until one is picked, QuickPress (or the first board) is.
  useEffect(() => {
    if (defaultBoardId && jiraBoards.some((board) => board.id === defaultBoardId)) {
      setSelectedBoardId(defaultBoardId);
    }
  }, [defaultBoardId, jiraBoards]);

  async function chooseBoard(boardId: string) {
    setSelectedBoardId(boardId);
    setBoardMenuOpen(false);
    if (boardSettings.status !== "ready" || boardId === defaultBoardId) {
      return;
    }
    const saved = await boardSettings.save(
      { ...boardSettings.values, defaultBoardId: boardId },
      boardSettings.revision,
    );
    if (!saved) {
      setJiraError(boardSettings.saveError ?? "Could not save the default board.");
    }
  }

  const selectedJiraBoard = jiraBoards.find((board) => board.id === selectedBoardId) ?? null;

  const refreshJira = useCallback(async () => {
    try {
      const board = await loadJiraBoard({
        boardId: selectedBoardId,
        projectKey: selectedJiraBoard?.projectKey ?? undefined,
      });
      setJiraIssues(board.issues);
      setJiraColumns(board.columns);
      setJiraSprint(board.sprint);
      setJiraError(board.error);
    } catch (cause) {
      setJiraIssues([]);
      setJiraColumns([]);
      setJiraSprint(null);
      setJiraError(cause instanceof Error ? cause.message : "Unable to read Jira board");
    }
  }, [loadJiraBoard, selectedBoardId, selectedJiraBoard?.projectKey]);

  useEffect(() => {
    void refreshSchedules();
  }, [refreshSchedules]);

  useEffect(() => {
    void refreshParents();
  }, [refreshParents]);

  useEffect(() => {
    void refreshJiraBoards();
  }, [refreshJiraBoards]);

  useEffect(() => {
    void refreshJira();
    const timer = setInterval(() => {
      void refreshJira();
    }, PR_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [refreshJira]);

  const board = useMemo(
    () =>
      // The phase board tracks agent sessions only; Jira issues get their own board below.
      createBoardModel(agents, workspaces, schedules, parentLinks),
    [agents, workspaces, schedules, parentLinks],
  );
  // Done work has merged; only look up PRs for issues still moving.
  const openIssueRefs = useMemo(
    () =>
      jiraIssues
        .filter((issue) => issue.statusCategory.toLowerCase() !== "done")
        .map((issue) => `${issue.id}:${issue.key}`)
        .join(","),
    [jiraIssues],
  );
  useEffect(() => {
    if (!openIssueRefs) {
      setJiraPrs([]);
      return;
    }
    let cancelled = false;
    const issues = openIssueRefs.split(",").map((ref) => {
      const [id = "", key = ""] = ref.split(":");
      return { id, key };
    });
    void loadJiraPrs({ issues })
      .then((result) => {
        if (!cancelled) {
          setJiraPrs(result.prs);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setJiraPrs([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadJiraPrs, openIssueRefs]);
  const prsByKey = useMemo(() => {
    const map = new Map<string, JiraPullRequest[]>();
    for (const pr of jiraPrs) {
      map.set(pr.issueKey, [...(map.get(pr.issueKey) ?? []), pr]);
    }
    return map;
  }, [jiraPrs]);

  const sessionItems = useMemo(
    () => [...board.phases.flatMap((phase) => phase.items), ...board.merged],
    [board.phases, board.merged],
  );
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);

  const trees = board.families.filter((family) => family.children.length > 0);
  const idlePhase = board.phases.find((phase) => phase.id === "todo");
  const livePhases = board.phases.filter((phase) => phase.id !== "todo");
  const lanes = useMemo(
    () => [
      ...livePhases.map((phase) => ({
        id: `phase:${phase.id}`,
        label: phase.label,
        hint: phase.hint,
        count: phase.items.length,
        kind: "phase" as const,
        items: phase.items,
      })),
      {
        id: "idle",
        label: "Idle",
        hint: idlePhase?.hint ?? "Not running yet",
        count: idlePhase?.items.length ?? 0,
        kind: "phase" as const,
        items: idlePhase?.items ?? [],
      },
      {
        id: "merged",
        label: "Merged",
        hint: "Shipped recently",
        count: board.mergedCount,
        kind: "merged" as const,
        items: board.merged,
      },
      {
        id: "blocked",
        label: "Blocked",
        hint: board.blockedSummary || "Waiting on a blocker",
        count: board.blockedCount,
        kind: "blocked" as const,
        items: board.blocked,
      },
    ],
    [board.blocked, board.blockedCount, board.blockedSummary, board.merged, board.mergedCount, idlePhase, livePhases],
  );
  const activeLaneId =
    lanes.some((lane) => lane.id === selectedLaneId)
      ? selectedLaneId
      : (lanes.find((lane) => lane.count > 0)?.id ?? lanes[0]?.id ?? "idle");
  const activeLane = lanes.find((lane) => lane.id === activeLaneId) ?? lanes[0];

  function toggleExpanded(id: string) {
    setExpanded((current) => ({ ...current, [id]: !current[id] }));
  }

  function openItem(item: BoardItem) {
    if (item.agentId && navigation) {
      navigation.openAgent({ agentId: item.agentId });
      return;
    }
    if (item.workspaceId && navigation) {
      navigation.openWorkspace({ workspaceId: item.workspaceId });
      return;
    }
    if (item.url) {
      void openExternalUrl(item.url);
    }
  }

  function openInJira(item: BoardItem) {
    if (item.url) {
      void openExternalUrl(item.url);
    }
  }

  async function startItem(item: BoardItem) {
    if (startingId || !item.startLabel) {
      return;
    }
    setStartingId(item.id);
    setSessionError(null);
    try {
      const started = await startJiraSession(paseo, item);
      if (navigation) {
        navigation.openAgent({ agentId: started.agentId });
      }
    } catch (cause) {
      setSessionError(cause instanceof Error ? cause.message : "Unable to start session");
    } finally {
      setStartingId(null);
    }
  }

  return (
    <View style={styles.screen}>
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>Orchestration</Text>
          <View style={styles.titleActions}>
            {pulse?.available ? (
              <ProdPulseButton pulse={pulse} theme={theme} onPress={() => setPulseOpen(true)} />
            ) : null}
            {jiraBoards.length > 0 || boardFilter !== null ? (
              <BoardPicker
                boards={jiraBoards}
                selectedId={selectedBoardId}
                open={boardMenuOpen}
                filter={boardFilter ?? ""}
                theme={theme}
                styles={styles}
                onFilterChange={(next) => void saveBoardFilter(next)}
                onOpenChange={setBoardMenuOpen}
                onSelect={(boardId) => {
                  void chooseBoard(boardId);
                }}
              />
            ) : null}
          </View>
        </View>
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
        {jiraError ? <Text style={styles.danger}>{jiraError}</Text> : null}
        {sessionError ? <Text style={styles.danger}>{sessionError}</Text> : null}

        <View style={styles.stats}>
          <ProgressStat
            label="PROGRESS"
            value={`${board.inProgress}/${board.total || 0}`}
            hint={board.hasJira ? `${board.total} on the board` : `${board.total} active agents`}
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

        {jiraColumns.length > 0 ? (
          <JiraBoard
            title={selectedJiraBoard?.name ?? "Jira board"}
            sprint={jiraSprint}
            issues={jiraIssues}
            columns={jiraColumns}
            sessions={sessionItems}
            prsByKey={prsByKey}
            prColors={{ foreground: theme.colors.foreground, muted: theme.colors.foregroundMuted }}
            defaultDeveloper={defaultDeveloper}
            onDeveloperChange={(next) => void saveDefaultDeveloper(next)}
            compact={layout.compact}
            selectedColumn={selectedJiraColumn}
            expanded={expanded}
            startingId={startingId}
            styles={styles}
            onSelectColumn={setSelectedJiraColumn}
            onToggle={toggleExpanded}
            onOpen={openItem}
            onOpenJira={openInJira}
            onStart={startItem}
          />
        ) : null}

        <View style={styles.panel}>
          <View style={styles.sectionHead}>
            <Text style={styles.panelTitle}>Phase board</Text>
            <Text style={styles.panelMeta}>{board.total} live sessions</Text>
          </View>
          {layout.compact ? (
            <View style={styles.mobileBoard}>
              <View style={styles.laneTabs}>
                {lanes.map((lane) => {
                  const selected = lane.id === activeLaneId;
                  return (
                    <Pressable
                      key={lane.id}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`${lane.label}, ${lane.count} items`}
                      onPress={() => {
                        setSelectedLaneId(lane.id);
                      }}
                      style={selected ? styles.laneTabSelected : styles.laneTab}
                    >
                      <Text style={selected ? styles.laneTabSelectedText : styles.laneTabText}>
                        {lane.label}
                      </Text>
                      <Text style={selected ? styles.laneTabSelectedCount : styles.laneTabCount}>
                        {lane.count}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {activeLane ? (
                <View style={styles.mobileLane}>
                  <Text style={styles.kanbanHint}>{activeLane.hint}</Text>
                  <LaneItems
                    lane={activeLane}
                    expanded
                    styles={styles}
                    startingId={startingId}
                    onToggle={() => undefined}
                    onOpen={openItem}
                    onStart={startItem}
                  />
                </View>
              ) : null}
            </View>
          ) : (
            <>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator
                style={styles.kanbanScroll}
                contentContainerStyle={styles.kanban}
              >
                {livePhases.map((phase) => (
                  <View key={phase.id} style={styles.kanbanCol}>
                    <View style={styles.kanbanHead}>
                      <Text style={styles.kanbanTitle}>{phase.label}</Text>
                      <Text style={styles.kanbanCount}>{phase.items.length}</Text>
                    </View>
                    <Text style={styles.kanbanHint}>{phase.hint}</Text>
                    <LaneItems
                      lane={{
                        id: `phase:${phase.id}`,
                        kind: "phase",
                        items: phase.items,
                        empty: "Empty",
                      }}
                      expanded={Boolean(expanded[`phase:${phase.id}`])}
                      styles={styles}
                      startingId={startingId}
                      onToggle={() => toggleExpanded(`phase:${phase.id}`)}
                      onOpen={openItem}
                      onStart={startItem}
                    />
                  </View>
                ))}
              </ScrollView>

              <ScrollView
                horizontal
                showsHorizontalScrollIndicator
                style={styles.kanbanScroll}
                contentContainerStyle={styles.phaseBoard}
              >
                <View style={styles.idleCol}>
                  <View style={styles.colHead}>
                    <View style={[styles.dot, { backgroundColor: theme.colors.foregroundMuted }]} />
                    <Text style={styles.colTitle}>Idle</Text>
                    <Text style={styles.colCount}>{idlePhase?.items.length ?? 0}</Text>
                  </View>
                  <Text style={styles.kanbanHint}>{idlePhase?.hint ?? "Not running yet"}</Text>
                  <LaneItems
                    lane={{
                      id: "idle",
                      kind: "phase",
                      items: idlePhase?.items ?? [],
                      empty: "Nothing idle.",
                    }}
                    expanded={Boolean(expanded.idle)}
                    styles={styles}
                    startingId={startingId}
                    onToggle={() => toggleExpanded("idle")}
                    onOpen={openItem}
                    onStart={startItem}
                  />
                </View>

                <View style={styles.mergedCol}>
                  <View style={styles.colHead}>
                    <View style={[styles.dot, { backgroundColor: theme.colors.statusSuccess }]} />
                    <Text style={styles.colTitle}>Merged</Text>
                    <Text style={styles.colCount}>{board.mergedCount}</Text>
                  </View>
                  <LaneItems
                    lane={{
                      id: "merged",
                      kind: "merged",
                      items: board.merged,
                      empty: "No merged items.",
                    }}
                    expanded={Boolean(expanded.merged)}
                    styles={styles}
                    startingId={startingId}
                    onToggle={() => toggleExpanded("merged")}
                    onOpen={openItem}
                    onStart={startItem}
                  />
                </View>

                <View style={styles.blockedCol}>
                  <View style={styles.colHead}>
                    <View style={[styles.dot, { backgroundColor: theme.colors.statusDanger }]} />
                    <Text style={styles.colTitle}>Blocked</Text>
                    <Text style={styles.colCount}>{board.blockedCount}</Text>
                  </View>
                  <LaneItems
                    lane={{
                      id: "blocked",
                      kind: "blocked",
                      items: board.blocked,
                      empty: "No blocked items.",
                    }}
                    expanded={Boolean(expanded.blocked)}
                    styles={styles}
                    startingId={startingId}
                    onToggle={() => toggleExpanded("blocked")}
                    onOpen={openItem}
                    onStart={startItem}
                  />
                </View>
              </ScrollView>
            </>
          )}
        </View>

        {trees.length > 0 || board.stories.length > 0 ? (
          <View style={styles.browse}>
            <View style={styles.sectionHead}>
              <Text style={styles.sectionLabel}>
                BROWSE · {trees.length} {trees.length === 1 ? "epic with children" : "epics with children"}
                {board.stories.length > 0 ? ` · ${board.stories.length} stories` : ""}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: Boolean(expanded.browse) }}
                accessibilityLabel={expanded.browse ? "Hide epic browse" : "Show epic browse"}
                onPress={() => toggleExpanded("browse")}
              >
                <Text style={styles.sectionToggle}>{expanded.browse ? "Hide" : "Show"}</Text>
              </Pressable>
            </View>
            {expanded.browse ? (
              <>
                <Text style={styles.sectionHint}>
                  Parent/child view for spawned work. Everything else lives on the phase board.
                </Text>
                {trees.map((family) => {
                  const open = Boolean(expanded[family.epic.id]);
                  const childCount = family.children.length;
                  return (
                    <View key={family.epic.id} style={styles.familyCard}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ expanded: open }}
                        accessibilityLabel={`${family.epic.key || family.epic.title}, ${childCount} children. ${open ? "Collapse" : "Expand"}`}
                        onPress={() => toggleExpanded(family.epic.id)}
                        style={styles.familySummary}
                      >
                        <Text style={styles.familyToggleText}>
                          {open ? "▾" : "▸"} {childCount}
                        </Text>
                        {family.epic.key ? (
                          <Text style={styles.waitKey}>{family.epic.key}</Text>
                        ) : null}
                        <Text style={styles.familySummaryTitle} numberOfLines={1}>
                          {family.epic.title}
                        </Text>
                        <Text style={styles.phaseChip}>{family.epic.phaseLabel}</Text>
                      </Pressable>
                      {open ? (
                        <>
                          <SessionCard
                            item={family.epic}
                            styles={styles}
                            starting={startingId === family.epic.id}
                            onOpen={openItem}
                            onStart={startItem}
                          />
                          {family.children.map((child) => (
                            <SessionCard
                              key={child.id}
                              item={child}
                              nested
                              styles={styles}
                              starting={startingId === child.id}
                              onOpen={openItem}
                              onStart={startItem}
                            />
                          ))}
                        </>
                      ) : null}
                    </View>
                  );
                })}
                {board.stories.length > 0 ? (
                  <>
                    <View style={styles.sectionHead}>
                      <Text style={styles.sectionLabel}>STORIES · {board.stories.length}</Text>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ expanded: Boolean(expanded.stories) }}
                        accessibilityLabel={expanded.stories ? "Hide stories" : "Show stories"}
                        onPress={() => toggleExpanded("stories")}
                      >
                        <Text style={styles.sectionToggle}>
                          {expanded.stories ? "Hide" : "Show"}
                        </Text>
                      </Pressable>
                    </View>
                    {expanded.stories
                      ? board.stories.map((item) => (
                          <SessionCard
                            key={item.id}
                            item={item}
                            styles={styles}
                            starting={startingId === item.id}
                            onOpen={openItem}
                            onStart={startItem}
                          />
                        ))
                      : null}
                  </>
                ) : null}
              </>
            ) : (
              <Text style={styles.sectionHint}>
                Optional parent/child list. Open it only when you need the tree.
              </Text>
            )}
          </View>
        ) : null}
      </ScrollView>
      {pulse?.available ? (
        <ProdPulseDrawer
          pulse={pulse}
          theme={theme}
          compact={layout.compact}
          open={pulseOpen}
          onClose={() => setPulseOpen(false)}
          onRefresh={refreshPulse}
        />
      ) : null}
    </View>
  );
}

const ALL_DEVELOPERS = "__all__";

function JiraBoard({
  title,
  sprint,
  issues,
  columns,
  sessions,
  prsByKey,
  prColors,
  defaultDeveloper,
  onDeveloperChange,
  compact,
  selectedColumn,
  expanded,
  startingId,
  styles,
  onSelectColumn,
  onToggle,
  onOpen,
  onOpenJira,
  onStart,
}: {
  title: string;
  sprint: JiraSprint | null;
  issues: JiraIssue[];
  columns: JiraBoardColumn[];
  sessions: BoardItem[];
  prsByKey: Map<string, JiraPullRequest[]>;
  prColors: { foreground: string; muted: string };
  defaultDeveloper: string;
  onDeveloperChange: (developer: string) => void;
  compact: boolean;
  selectedColumn: string | null;
  expanded: Record<string, boolean>;
  startingId: string | null;
  styles: ReturnType<typeof createStyles>;
  onSelectColumn: (name: string) => void;
  onToggle: (id: string) => void;
  onOpen: (item: BoardItem) => void;
  onOpenJira: (item: BoardItem) => void;
  onStart: (item: BoardItem) => void;
}) {
  const [developer, setDeveloper] = useState(defaultDeveloper || ALL_DEVELOPERS);
  // Settings load after the first render; adopt the saved default once it arrives.
  useEffect(() => {
    setDeveloper(defaultDeveloper || ALL_DEVELOPERS);
  }, [defaultDeveloper]);
  const developers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of issues) {
      counts.set(issue.assignee, (counts.get(issue.assignee) ?? 0) + 1);
    }
    // Most-loaded first; "Unassigned" always last.
    return [...counts.entries()].sort(([leftName, left], [rightName, right]) =>
      leftName === "Unassigned"
        ? 1
        : rightName === "Unassigned"
          ? -1
          : right - left || leftName.localeCompare(rightName),
    );
  }, [issues]);
  const activeDeveloper = developers.some(([name]) => name === developer)
    ? developer
    : ALL_DEVELOPERS;
  const visibleIssues = useMemo(
    () =>
      activeDeveloper === ALL_DEVELOPERS
        ? issues
        : issues.filter((issue) => issue.assignee === activeDeveloper),
    [issues, activeDeveloper],
  );
  const groups = useMemo(
    () => groupJiraColumns(visibleIssues, columns, sessions),
    [visibleIssues, columns, sessions],
  );
  const meta = sprint
    ? `${sprint.name}${sprint.endDate ? ` · ends ${new Date(sprint.endDate).toLocaleDateString()}` : ""} · ${visibleIssues.length} issues`
    : `${visibleIssues.length} issues`;
  const active =
    groups.find((group) => group.name === selectedColumn && group.items.length > 0) ??
    groups.find((group) => group.items.length > 0) ??
    groups[0];

  function cards(group: JiraColumnGroup) {
    const id = `jira:${group.name}`;
    return (
      <PreviewList
        items={group.items}
        expanded={compact || Boolean(expanded[id])}
        empty="Empty"
        styles={styles}
        onToggle={() => onToggle(id)}
        renderItem={(item) => (
          <JiraCard
            key={item.id}
            item={item}
            column={group.name}
            prs={prsByKey.get(item.key) ?? []}
            prColors={prColors}
            styles={styles}
            starting={startingId === item.id}
            onOpen={onOpen}
            onOpenJira={onOpenJira}
            onStart={onStart}
          />
        )}
      />
    );
  }

  return (
    <View style={styles.panel}>
      <View style={[styles.sectionHead, styles.jiraHead]}>
        <Text style={styles.panelTitle}>{title}</Text>
        <View style={[styles.jiraHeadRight, styles.jiraHead]}>
          <Text style={styles.panelMeta}>{meta}</Text>
          {developers.length > 1 ? (
            <DeveloperPicker
              options={[[ALL_DEVELOPERS, issues.length] as const, ...developers]}
              selected={activeDeveloper}
              styles={styles}
              onSelect={(name) => {
                setDeveloper(name);
                onDeveloperChange(name === ALL_DEVELOPERS ? "" : name);
              }}
            />
          ) : null}
        </View>
      </View>
      {sprint?.goal ? <Text style={styles.sectionHint}>{sprint.goal}</Text> : null}
      {compact ? (
        <View style={styles.mobileBoard}>
          <View style={styles.laneTabs}>
            {groups.map((group) => {
              const selected = group.name === active?.name;
              return (
                <Pressable
                  key={group.name}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${group.name}, ${group.items.length} issues`}
                  disabled={group.items.length === 0}
                  onPress={() => onSelectColumn(group.name)}
                  style={selected ? styles.laneTabSelected : styles.laneTab}
                >
                  <Text style={selected ? styles.laneTabSelectedText : styles.laneTabText}>
                    {group.name}
                  </Text>
                  <Text style={selected ? styles.laneTabSelectedCount : styles.laneTabCount}>
                    {group.items.length}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {active ? <View style={styles.mobileLane}>{cards(active)}</View> : null}
        </View>
      ) : (
        <View style={styles.jiraColumns}>
          {groups.map((group) =>
            group.items.length === 0 ? (
              // Empty columns stay collapsed so the populated ones get the room.
              <View
                key={group.name}
                accessibilityLabel={`${group.name}, empty`}
                style={styles.jiraColCollapsed}
              >
                <Text style={styles.kanbanCount}>0</Text>
                <Text style={styles.jiraColCollapsedTitle}>{group.name}</Text>
              </View>
            ) : (
              <View key={group.name} style={styles.jiraCol}>
                <View style={styles.kanbanHead}>
                  <Text style={styles.kanbanTitle}>{group.name}</Text>
                  <Text style={styles.kanbanCount}>{group.items.length}</Text>
                </View>
                {cards(group)}
              </View>
            ),
          )}
        </View>
      )}
    </View>
  );
}

function DeveloperPicker({
  options,
  selected,
  styles,
  onSelect,
}: {
  options: ReadonlyArray<readonly [string, number]>;
  selected: string;
  styles: ReturnType<typeof createStyles>;
  onSelect: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const labelFor = (name: string) => (name === ALL_DEVELOPERS ? "Everyone" : name);
  const label = labelFor(selected);
  return (
    <View style={styles.popoverAnchor}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Developer, ${label}. ${open ? "Collapse" : "Expand"} developer list`}
        onPress={() => setOpen((current) => !current)}
        style={[styles.picker, styles.pickerButton]}
      >
        <Text style={styles.pickerButtonText} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.pickerChevron}>{open ? "▴" : "▾"}</Text>
      </Pressable>
      {open ? (
        // Floats over the board instead of pushing it down.
        <ScrollView style={styles.popover} nestedScrollEnabled>
          {options.map(([name, count]) => {
            const isSelected = name === selected;
            return (
              <Pressable
                key={name}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
                accessibilityLabel={`${labelFor(name)}, ${count} issues`}
                onPress={() => {
                  onSelect(name);
                  setOpen(false);
                }}
                style={[styles.pickerOption, isSelected ? styles.pickerOptionSelected : null]}
              >
                <Text
                  style={[
                    styles.pickerOptionText,
                    isSelected ? styles.pickerOptionTextSelected : null,
                  ]}
                >
                  {labelFor(name)}
                </Text>
                <Text style={styles.pickerOptionMeta}>{count}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
    </View>
  );
}

function JiraCard({
  item,
  column,
  prs,
  prColors,
  styles,
  starting,
  onOpen,
  onOpenJira,
  onStart,
}: {
  item: BoardItem;
  column: string;
  prs: JiraPullRequest[];
  prColors: { foreground: string; muted: string };
  styles: ReturnType<typeof createStyles>;
  starting: boolean;
  onOpen: (item: BoardItem) => void;
  onOpenJira: (item: BoardItem) => void;
  onStart: (item: BoardItem) => void;
}) {
  // The column already names the status; only call it out when they differ.
  const status = item.phaseLabel.toLowerCase() === column.toLowerCase() ? null : item.phaseLabel;
  return (
    <View style={styles.jiraCard}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${item.key} ${item.title}`}
        onPress={() => onOpen(item)}
        style={styles.cardBody}
      >
        <View style={styles.jiraCardHead}>
          <Text style={styles.cardKey}>{item.key}</Text>
          {status ? <Text style={styles.phaseChip}>{status}</Text> : null}
        </View>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {item.title}
        </Text>
        {item.underTitle ? (
          <Text style={styles.cardMeta} numberOfLines={1}>
            Under {item.underTitle}
          </Text>
        ) : null}
        <Text style={styles.cardMeta} numberOfLines={1}>
          {item.detail}
        </Text>
      </Pressable>
      {prs.map((pr) => (
        <Pressable
          key={pr.url}
          accessibilityRole="link"
          accessibilityLabel={`Pull request ${pr.number}, ${pr.status.toLowerCase()}, ${pr.title}`}
          onPress={() => void openExternalUrl(pr.url)}
          style={styles.prRow}
        >
          <View style={styles.prRowLine}>
            <Icon name="Github" size={14} color={prColors.foreground} />
            <Text style={styles.prRowHead}>#{pr.number}</Text>
            <Text style={pr.status === "DRAFT" ? styles.prDraft : styles.prOpen}>
              {pr.status === "DRAFT" ? "Draft" : "Open"}
            </Text>
            {pr.repo ? (
              <Text style={styles.prRepo} numberOfLines={1}>
                {pr.repo.split("/").pop()}
              </Text>
            ) : null}
          </View>
          {pr.branch ? (
            <View style={styles.prRowLine}>
              <Icon name="GitBranch" size={12} color={prColors.muted} />
              <Text style={styles.prBranch} numberOfLines={1}>
                {pr.branch}
              </Text>
            </View>
          ) : null}
        </Pressable>
      ))}
      {item.retryLabel || item.startLabel ? (
        <View style={styles.blockedActions}>
          {item.retryLabel ? (
            <Pill label={item.retryLabel} styles={styles} onPress={() => onOpen(item)} />
          ) : null}
          {item.retryLabel && item.url ? (
            <Pill label="Open in Jira" styles={styles} onPress={() => onOpenJira(item)} />
          ) : null}
          {item.startLabel ? (
            <Pill
              label={starting ? "Starting…" : item.startLabel}
              styles={styles}
              onPress={() => onStart(item)}
            />
          ) : null}
        </View>
      ) : null}
    </View>
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

type BoardLane = {
  id: string;
  kind: "phase" | "merged" | "blocked";
  items: BoardItem[];
  empty?: string;
};

function LaneItems({
  lane,
  expanded,
  styles,
  startingId,
  onToggle,
  onOpen,
  onStart,
}: {
  lane: BoardLane;
  expanded: boolean;
  styles: ReturnType<typeof createStyles>;
  startingId: string | null;
  onToggle: () => void;
  onOpen: (item: BoardItem) => void;
  onStart: (item: BoardItem) => void;
}) {
  const empty =
    lane.empty ??
    (lane.kind === "merged"
      ? "No merged items."
      : lane.kind === "blocked"
        ? "No blocked items."
        : lane.id === "idle"
          ? "Nothing idle."
          : "Empty");

  if (lane.kind === "merged") {
    return (
      <PreviewList
        items={lane.items}
        expanded={expanded}
        empty={empty}
        styles={styles}
        onToggle={onToggle}
        renderItem={(item) => (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            accessibilityLabel={`${item.key} ${item.title}`}
            onPress={() => onOpen(item)}
            style={styles.mergedRow}
          >
            <Text style={styles.mergedKey}>{item.key}</Text>
            <Text style={styles.mergedTitle} numberOfLines={2}>
              {item.title}
            </Text>
            {item.pr ? <Text style={styles.pr}>#{item.pr}</Text> : null}
          </Pressable>
        )}
      />
    );
  }

  if (lane.kind === "blocked") {
    return (
      <PreviewList
        items={lane.items}
        expanded={expanded}
        empty={empty}
        styles={styles}
        onToggle={onToggle}
        renderItem={(item) => (
          <View key={item.id} style={styles.blockedCard}>
            <View style={styles.blockedHead}>
              <View style={styles.blockedHeadLeft}>
                <RoleTag role={item.role} styles={styles} />
                {item.source !== "session" ? <Text style={styles.phaseChip}>Jira</Text> : null}
                {item.key ? <Text style={styles.blockedKey}>{item.key}</Text> : null}
              </View>
              {item.pr ? <Text style={styles.pr}>#{item.pr}</Text> : null}
            </View>
            <Text style={styles.blockedTitle}>{item.title}</Text>
            {item.underTitle ? <Text style={styles.underLine}>Under {item.underTitle}</Text> : null}
            <Text style={styles.waitDetail}>{item.detail}</Text>
            {item.progress !== null ? (
              <View style={styles.barTrack}>
                <View
                  style={[
                    styles.blockedBarFill,
                    {
                      width: `${Math.round(item.progress * 100)}%`,
                    },
                  ]}
                />
              </View>
            ) : null}
            {item.retryLabel || item.startLabel ? (
              <View style={styles.blockedActions}>
                {item.retryLabel ? (
                  <Pill label={item.retryLabel} styles={styles} onPress={() => onOpen(item)} />
                ) : null}
                {item.startLabel ? (
                  <Pill
                    label={startingId === item.id ? "Starting…" : item.startLabel}
                    styles={styles}
                    onPress={() => onStart(item)}
                  />
                ) : null}
              </View>
            ) : null}
          </View>
        )}
      />
    );
  }

  return (
    <PreviewList
      items={lane.items}
      expanded={expanded}
      empty={empty}
      styles={styles}
      onToggle={onToggle}
      renderItem={(item) => (
        <SessionCard
          key={item.id}
          item={item}
          styles={styles}
          starting={startingId === item.id}
          onOpen={onOpen}
          onStart={onStart}
        />
      )}
    />
  );
}

const PREVIEW_LIMIT = 5;

function PreviewList<T>({
  items,
  expanded,
  empty,
  styles,
  onToggle,
  renderItem,
}: {
  items: T[];
  expanded: boolean;
  empty: string;
  styles: ReturnType<typeof createStyles>;
  onToggle: () => void;
  renderItem: (item: T) => ReactNode;
}) {
  if (items.length === 0) {
    return <Text style={styles.muted}>{empty}</Text>;
  }
  const hidden = items.length - PREVIEW_LIMIT;
  const visible = expanded || hidden <= 0 ? items : items.slice(0, PREVIEW_LIMIT);
  const label = expanded ? "Collapse" : `More · ${hidden}`;
  return (
    <>
      {visible.map(renderItem)}
      {hidden > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={expanded ? "Collapse list" : `Show ${hidden} more items`}
          onPress={onToggle}
        >
          <Text style={styles.moreToggle}>{label}</Text>
        </Pressable>
      ) : null}
    </>
  );
}

function SessionCard({
  item,
  nested,
  styles,
  starting,
  onOpen,
  onStart,
}: {
  item: BoardItem;
  nested?: boolean;
  styles: ReturnType<typeof createStyles>;
  starting?: boolean;
  onOpen: (item: BoardItem) => void;
  onStart: (item: BoardItem) => void;
}) {
  return (
    <View style={[styles.phaseItem, nested ? styles.childItem : null]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${item.role} ${item.title}`}
        onPress={() => onOpen(item)}
        style={styles.cardBody}
      >
        <View style={styles.cardChips}>
          <RoleTag role={item.role} styles={styles} />
          {item.source !== "session" ? <Text style={styles.phaseChip}>Jira</Text> : null}
          <Text style={styles.phaseChip}>{item.phaseLabel}</Text>
        </View>
        {item.key ? <Text style={styles.cardKey}>{item.key}</Text> : null}
        <Text style={styles.cardTitle} numberOfLines={2}>
          {item.title}
        </Text>
        {item.underTitle ? <Text style={styles.cardMeta}>Under {item.underTitle}</Text> : null}
        {item.detail ? (
          <Text style={styles.cardMeta} numberOfLines={2}>
            {item.detail}
          </Text>
        ) : null}
      </Pressable>
      {item.retryLabel || item.startLabel ? (
        <View style={styles.blockedActions}>
          {item.retryLabel ? (
            <Pill label={item.retryLabel} styles={styles} onPress={() => onOpen(item)} />
          ) : null}
          {item.startLabel ? (
            <Pill
              label={starting ? "Starting…" : item.startLabel}
              styles={styles}
              onPress={() => onStart(item)}
            />
          ) : null}
        </View>
      ) : null}
    </View>
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

function BoardPicker({
  boards,
  selectedId,
  open,
  filter,
  theme,
  styles,
  onFilterChange,
  onOpenChange,
  onSelect,
}: {
  boards: JiraBoardOption[];
  selectedId: string;
  open: boolean;
  filter: string;
  theme: PluginSurfaceProps["theme"];
  styles: ReturnType<typeof createStyles>;
  onFilterChange: (filter: string) => void;
  onOpenChange: (open: boolean) => void;
  onSelect: (boardId: string) => void;
}) {
  const [filterDraft, setFilterDraft] = useState(filter);
  const committedFilter = useRef(filter);
  useEffect(() => {
    committedFilter.current = filter;
    setFilterDraft(filter);
  }, [filter]);
  // Submit and blur both fire on Enter; only commit a value once.
  const commitFilter = () => {
    const next = filterDraft.trim();
    if (next === committedFilter.current) {
      return;
    }
    committedFilter.current = next;
    onFilterChange(next);
  };
  const selected = boards.find((board) => board.id === selectedId) ?? boards[0];
  const label = selected ? selected.name : "No matching boards";
  return (
    <View style={styles.picker}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Jira board, ${label}. ${open ? "Collapse" : "Expand"} board list`}
        onPress={() => onOpenChange(!open)}
        style={styles.pickerButton}
      >
        <Text style={styles.pickerButtonText} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.pickerChevron}>{open ? "▴" : "▾"}</Text>
      </Pressable>
      <Modal
        title="Jira boards"
        icon={<Icon name="LayoutGrid" size={18} color={theme.colors.foreground} />}
        open={open}
        onOpenChange={onOpenChange}
      >
        <Modal.Content
          scrollable={false}
          style={{ backgroundColor: theme.colors.surface1 }}
          contentContainerStyle={{ padding: 0, gap: 0 }}
        >
          <TextInput
            accessibilityLabel="Filter Jira boards by name"
            placeholder="Filter boards by name (empty shows all)"
            placeholderTextColor={theme.colors.foregroundMuted}
            value={filterDraft}
            onChangeText={setFilterDraft}
            onSubmitEditing={commitFilter}
            onBlur={commitFilter}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.pickerFilter}
          />
          <ScrollView style={styles.pickerMenu} nestedScrollEnabled>
            {boards.length === 0 ? (
              <Text style={styles.pickerEmpty}>
                No boards match this filter. Clear it and press Enter to list every board.
              </Text>
            ) : (
              boards.map((board, index) => {
                const selectedBoard = board.id === selectedId;
                return (
                  <Pressable
                    key={board.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: selectedBoard }}
                    accessibilityLabel={`${board.name}${board.projectKey ? `, ${board.projectKey}` : ""}`}
                    onPress={() => onSelect(board.id)}
                    style={[
                      styles.pickerOption,
                      index === 0 ? styles.pickerOptionFirst : null,
                      selectedBoard ? styles.pickerOptionSelected : null,
                    ]}
                  >
                    <Text
                      style={[
                        styles.pickerOptionText,
                        selectedBoard ? styles.pickerOptionTextSelected : null,
                      ]}
                    >
                      {board.name}
                    </Text>
                    {board.projectKey ? (
                      <Text style={styles.pickerOptionMeta}>{board.projectKey}</Text>
                    ) : null}
                  </Pressable>
                );
              })
            )}
          </ScrollView>
        </Modal.Content>
      </Modal>
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
      alignSelf: "stretch" as const,
      width: "100%" as const,
    },
    titleRow: {
      // Keeps the board menu above the sections that follow it.
      zIndex: 10,
      flexDirection: compact ? ("column" as const) : ("row" as const),
      alignItems: compact ? ("stretch" as const) : ("flex-start" as const),
      justifyContent: "space-between" as const,
      gap: 12,
    },
    titleActions: {
      flexDirection: compact ? ("column" as const) : ("row" as const),
      alignItems: compact ? ("stretch" as const) : ("flex-start" as const),
      gap: 8,
    },
    title: {
      color: theme.colors.foreground,
      fontSize: compact ? 22 : 28,
      fontWeight: "600" as const,
      flexShrink: 1,
    },
    picker: {
      minWidth: compact ? undefined : 220,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 12,
      backgroundColor: theme.colors.surface1,
    },
    pickerMenu: {
      maxHeight: 360,
    },
    pickerEmpty: {
      color: theme.colors.foregroundMuted,
      paddingHorizontal: 12,
      paddingVertical: 16,
    },
    pickerButton: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    pickerButtonText: {
      color: theme.colors.foreground,
      flexShrink: 1,
    },
    pickerChevron: {
      color: theme.colors.foregroundMuted,
    },
    pickerFilter: {
      color: theme.colors.foreground,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    pickerOption: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    pickerOptionFirst: {
      borderTopWidth: 0,
    },
    pickerOptionSelected: {
      backgroundColor: theme.colors.surface2,
    },
    pickerOptionText: {
      color: theme.colors.foreground,
      flexShrink: 1,
    },
    pickerOptionTextSelected: {
      fontWeight: "600" as const,
    },
    pickerOptionMeta: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
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
    blockedBarFill: {
      height: 3,
      borderRadius: 2,
      backgroundColor: theme.colors.statusDanger,
    },
    panel: {
      alignSelf: "stretch" as const,
      width: "100%" as const,
      gap: 12,
      padding: compact ? 14 : 18,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    panelTitle: {
      color: theme.colors.foreground,
      fontSize: compact ? 16 : 18,
      fontWeight: "600" as const,
    },
    panelMeta: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    mobileBoard: {
      gap: 12,
    },
    laneTabs: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: 8,
    },
    laneTab: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    },
    laneTabSelected: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 999,
      backgroundColor: theme.colors.accent,
    },
    laneTabText: {
      color: theme.colors.foreground,
      fontSize: 13,
    },
    laneTabSelectedText: {
      color: theme.colors.accentForeground,
      fontSize: 13,
      fontWeight: "600" as const,
    },
    laneTabCount: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    laneTabSelectedCount: {
      color: theme.colors.accentForeground,
      fontSize: 12,
    },
    mobileLane: {
      gap: 8,
      padding: 12,
      borderRadius: 12,
      backgroundColor: theme.colors.surface0,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    kanbanScroll: {
      alignSelf: "stretch" as const,
      width: "100%" as const,
    },
    kanban: {
      flexDirection: "row" as const,
      alignItems: "stretch" as const,
      alignSelf: "stretch" as const,
      flexGrow: 1,
      width: "100%" as const,
      gap: 10,
      paddingBottom: 4,
    },
    jiraHeadRight: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 10,
    },
    jiraHead: {
      zIndex: 20,
    },
    popoverAnchor: {
      position: "relative" as const,
      zIndex: 20,
    },
    popover: {
      position: "absolute" as const,
      top: "100%" as const,
      right: 0,
      marginTop: 4,
      minWidth: 240,
      maxHeight: 320,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 12,
      backgroundColor: theme.colors.surface1,
      zIndex: 20,
      elevation: 8,
      shadowColor: "#000",
      shadowOpacity: 0.3,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 6 },
    },
    // No sideways scroll: populated columns split the width evenly, empty ones stay narrow.
    jiraColumns: {
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      width: "100%" as const,
      gap: 8,
    },
    jiraCol: {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      minWidth: 0,
      gap: 8,
      padding: 10,
      borderRadius: 12,
      backgroundColor: theme.colors.surface0,
    },
    jiraColCollapsed: {
      width: 56,
      flexShrink: 0,
      alignItems: "center" as const,
      gap: 6,
      paddingVertical: 10,
      paddingHorizontal: 4,
      borderRadius: 12,
      backgroundColor: theme.colors.surface0,
      opacity: 0.6,
    },
    jiraColCollapsedTitle: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      textAlign: "center" as const,
    },
    jiraCard: {
      gap: 8,
      padding: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    jiraCardHead: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: 8,
    },
    kanbanCol: {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      minWidth: compact ? 180 : 0,
      gap: 8,
      padding: 10,
      borderRadius: 12,
      backgroundColor: theme.colors.surface0,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    kanbanHead: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: 8,
    },
    kanbanTitle: {
      color: theme.colors.foreground,
      fontSize: 13,
      fontWeight: "600" as const,
    },
    kanbanCount: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    kanbanHint: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
    },
    moreToggle: {
      color: theme.colors.accent,
      fontSize: 12,
      paddingVertical: 4,
    },
    browse: {
      gap: 10,
      paddingTop: 4,
    },
    familySummary: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
    },
    familySummaryTitle: {
      color: theme.colors.foreground,
      flex: 1,
      flexShrink: 1,
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
      flexDirection: "row" as const,
      alignItems: "stretch" as const,
      alignSelf: "stretch" as const,
      flexGrow: 1,
      width: "100%" as const,
      gap: 10,
    },
    phaseColumns: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: compact ? 8 : 10,
      width: "100%" as const,
    },
    phaseCol: {
      flexGrow: 1,
      flexBasis: compact ? 88 : 0,
      minWidth: compact ? 88 : 0,
      alignItems: "center" as const,
      gap: 6,
      paddingVertical: 10,
      paddingHorizontal: 4,
      borderRadius: 12,
    },
    phaseColSelected: {
      backgroundColor: theme.colors.surface0,
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
    phaseGrid: {
      gap: 12,
      width: "100%" as const,
    },
    phaseRow: {
      flexDirection: "row" as const,
      alignItems: "stretch" as const,
      gap: 12,
      width: "100%" as const,
    },
    phaseCell: {
      flex: 1,
      maxWidth: 300,
      minWidth: 0,
    },
    cardBody: {
      flexDirection: "column" as const,
      alignItems: "flex-start" as const,
      alignSelf: "stretch" as const,
      gap: 6,
    },
    cardChips: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      alignItems: "center" as const,
      gap: 6,
    },
    cardKey: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    cardTitle: {
      color: theme.colors.foreground,
      fontSize: 15,
      fontWeight: "500" as const,
    },
    cardMeta: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    prRow: {
      gap: 2,
      paddingVertical: 6,
      paddingHorizontal: 8,
      borderRadius: 8,
      backgroundColor: theme.colors.surface2,
    },
    prRowLine: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
    },
    prRowHead: {
      color: theme.colors.foreground,
      fontSize: 12,
      fontWeight: "600" as const,
    },
    prOpen: {
      color: theme.colors.statusSuccess,
      fontSize: 11,
      fontWeight: "600" as const,
    },
    prDraft: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      fontWeight: "600" as const,
    },
    prRepo: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      flexShrink: 1,
    },
    prBranch: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      fontFamily: "monospace",
      flexShrink: 1,
    },
    phaseListHint: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    phaseItem: {
      flexDirection: "column" as const,
      alignItems: "flex-start" as const,
      alignSelf: "stretch" as const,
      gap: 6,
      paddingVertical: 10,
      paddingHorizontal: 10,
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
    idleCol: {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      minWidth: compact ? 180 : 0,
      gap: 8,
      padding: 10,
      borderRadius: 12,
      backgroundColor: theme.colors.surface0,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    mergedCol: {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      minWidth: compact ? 180 : 0,
      gap: 8,
      padding: 10,
      borderRadius: 12,
      backgroundColor: theme.colors.surface0,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    blockedCol: {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      minWidth: compact ? 180 : 0,
      gap: 10,
      padding: 10,
      borderRadius: 12,
      backgroundColor: theme.colors.surface0,
      borderWidth: 1,
      borderColor: theme.colors.border,
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
      alignItems: "flex-start" as const,
      flexWrap: "wrap" as const,
      gap: 8,
      paddingVertical: compact ? 10 : 6,
    },
    mergedKey: {
      color: theme.colors.foregroundMuted,
      minWidth: compact ? undefined : 56,
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
      backgroundColor: theme.colors.surface0,
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
      flexWrap: "wrap" as const,
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
