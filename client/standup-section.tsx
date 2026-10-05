import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { openExternalUrl, useRpc, useSettings } from "@getpaseo/plugin/client";
import { FlatList, Icon, Modal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import {
  detectOrchestrationObsidian,
  listOrchestrationFolders,
  listOrchestrationMergedPrs,
  listOrchestrationStandupTodos,
  listOrchestrationStandupWork,
  listOrchestrationTemplates,
  saveOrchestrationStandupTodos,
  upsertOrchestrationStandupNote,
  type StandupTodo,
  type StandupTodoKind,
} from "../shared/orchestration";
import { standupSettings } from "../shared/settings";
import { PR_POLL_MS } from "../shared/timing";

type FolderListing = RpcOutput<typeof listOrchestrationFolders>;
type TemplateListing = RpcOutput<typeof listOrchestrationTemplates>;
type MergedListing = RpcOutput<typeof listOrchestrationMergedPrs>;
type WorkListing = RpcOutput<typeof listOrchestrationStandupWork>;
type MergedPr = MergedListing["prs"][number];
type StandupStyles = ReturnType<typeof createStyles>;

export function StandupSection({
  theme,
  layout,
}: Pick<PluginSurfaceProps, "theme" | "layout">) {
  const settings = useSettings(standupSettings);
  const listFolders = useRpc(listOrchestrationFolders);
  const listTemplates = useRpc(listOrchestrationTemplates);
  const listMerged = useRpc(listOrchestrationMergedPrs);
  const listWork = useRpc(listOrchestrationStandupWork);
  const upsertNote = useRpc(upsertOrchestrationStandupNote);
  const listTodos = useRpc(listOrchestrationStandupTodos);
  const saveTodos = useRpc(saveOrchestrationStandupTodos);
  const detectObsidian = useRpc(detectOrchestrationObsidian);
  const toast = useToast();
  const [browseOpen, setBrowseOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [templates, setTemplates] = useState<TemplateListing>({
    templates: [],
    suggestedPath: null,
  });
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notePath, setNotePath] = useState<string | null>(null);
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [detectedLabel, setDetectedLabel] = useState<string | null>(null);
  const [merged, setMerged] = useState<MergedListing>({ date: "", prs: [], error: null });
  const [work, setWork] = useState<WorkListing>({ items: [], error: null });
  const [todos, setTodos] = useState<StandupTodo[]>([]);
  const [todoKind, setTodoKind] = useState<StandupTodoKind>("todo");
  const [todoDraft, setTodoDraft] = useState("");
  const [todoBusy, setTodoBusy] = useState(false);
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const folderPath = settings.status === "ready" ? settings.values.standupFolder : "";
  const templatePath = settings.status === "ready" ? settings.values.templatePath : "";
  const selectedTemplate =
    templates.templates.find((template) => template.path === templatePath) ?? null;
  const { workPrs, personalPrs } = useMemo(() => {
    const workProjects = new Set(work.items.map((item) => item.projectKey));
    const workKeys = new Set(work.items.map((item) => item.key));
    const isWork = (pr: MergedPr) =>
      pr.key.length > 0 && (workKeys.has(pr.key) || workProjects.has(pr.key.split("-")[0]));
    return {
      workPrs: merged.prs.filter(isWork),
      personalPrs: merged.prs.filter((pr) => !isWork(pr)),
    };
  }, [merged.prs, work.items]);

  const refreshTemplates = useCallback(
    async (nextFolder: string | null) => {
      try {
        setTemplates(await listTemplates({ folderPath: nextFolder }));
      } catch {
        setTemplates({ templates: [], suggestedPath: null });
      }
    },
    [listTemplates],
  );

  useEffect(() => {
    void detectObsidian({})
      .then((detected) => {
        setVaultPath(detected.vaultPath);
        setDetectedLabel(detected.label);
      })
      .catch(() => {
        setVaultPath(null);
        setDetectedLabel(null);
      });
  }, [detectObsidian]);

  useEffect(() => {
    void refreshTemplates(folderPath || vaultPath);
  }, [folderPath, refreshTemplates, vaultPath]);

  useEffect(() => {
    let cancelled = false;
    async function refreshMerged() {
      try {
        const listing = await listMerged({});
        if (!cancelled) {
          setMerged(listing);
        }
      } catch (error) {
        if (!cancelled) {
          setMerged({
            date: "",
            prs: [],
            error: error instanceof Error ? error.message : "Unable to list merged pull requests.",
          });
        }
      }
    }
    void refreshMerged();
    const timer = setInterval(() => {
      void refreshMerged();
    }, PR_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [listMerged]);

  useEffect(() => {
    let cancelled = false;
    async function refreshWork() {
      try {
        const listing = await listWork({});
        if (!cancelled) {
          setWork(listing);
        }
      } catch (error) {
        if (!cancelled) {
          setWork({
            items: [],
            error: error instanceof Error ? error.message : "Unable to list DCE stories.",
          });
        }
      }
    }
    void refreshWork();
    const timer = setInterval(() => {
      void refreshWork();
    }, PR_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [listWork]);

  const refreshTodos = useCallback(
    async (nextFolder: string) => {
      try {
        const listing = await listTodos({ folderPath: nextFolder });
        setTodos(listing.items);
        setNotePath(listing.notePath);
      } catch {
        setTodos([]);
      }
    },
    [listTodos],
  );

  useEffect(() => {
    if (!folderPath) {
      setTodos([]);
      return;
    }
    void refreshTodos(folderPath);
  }, [folderPath, refreshTodos]);

  const loadFolder = useCallback(
    async (nextPath: string | null) => {
      setBusy(true);
      setBrowseError(null);
      try {
        setListing(await listFolders({ path: nextPath }));
      } catch (error) {
        setBrowseError(error instanceof Error ? error.message : "Unable to list folders.");
      } finally {
        setBusy(false);
      }
    },
    [listFolders],
  );

  async function openBrowser() {
    setBrowseOpen(true);
    await loadFolder(vaultPath || folderPath || null);
  }

  async function saveValues(next: { standupFolder?: string; templatePath?: string }) {
    if (settings.status !== "ready") {
      return;
    }
    const saved = await settings.save({ ...settings.values, ...next }, settings.revision);
    if (!saved) {
      throw new Error(settings.saveError ?? "Could not save standup settings.");
    }
  }

  async function saveFolderAndUpdate(selectedPath: string) {
    setBusy(true);
    setBrowseError(null);
    try {
      const templateListing = await listTemplates({ folderPath: selectedPath });
      setTemplates(templateListing);
      const nextTemplate = templatePath || templateListing.suggestedPath || "";
      await saveValues({ standupFolder: selectedPath, templatePath: nextTemplate });
      const result = await upsertNote({
        folderPath: selectedPath,
        templatePath: nextTemplate || null,
      });
      setNotePath(result.notePath);
      setMerged((current) => ({ ...current, prs: result.prs, error: null }));
      if (!result.workError) {
        setWork({ items: result.work, error: null });
      }
      await refreshTodos(selectedPath);
      setBrowseOpen(false);
      toast.show(
        result.created
          ? `Created today’s note from ${result.templateName ?? "the template"}.`
          : "Updated today’s standup note.",
        { variant: "success" },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to update the standup note.";
      setBrowseError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  async function updateExistingFolder() {
    if (!folderPath) {
      await openBrowser();
      return;
    }
    await saveFolderAndUpdate(folderPath);
  }

  async function persistTodos(nextItems: StandupTodo[], nextFolder = folderPath) {
    if (!nextFolder) {
      throw new Error("Select a standup folder first.");
    }
    setTodoBusy(true);
    try {
      const result = await saveTodos({
        folderPath: nextFolder,
        templatePath: templatePath || null,
        items: nextItems.map((item) => ({
          kind: item.kind,
          text: item.text,
          done: item.done,
        })),
      });
      setTodos(result.items);
      setNotePath(result.notePath);
      return result;
    } finally {
      setTodoBusy(false);
    }
  }

  async function addTodo() {
    const text = todoDraft.trim();
    if (!text || !folderPath) {
      return;
    }
    try {
      await persistTodos([...todos, { id: "draft", kind: todoKind, text, done: false }]);
      setTodoDraft("");
      toast.show(`Added ${todoKind} to today’s note.`, { variant: "success" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save the todo note.");
    }
  }

  async function toggleTodo(id: string) {
    try {
      await persistTodos(
        todos.map((item) => (item.id === id ? { ...item, done: !item.done } : item)),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update the todo note.");
    }
  }

  async function removeTodo(id: string) {
    try {
      await persistTodos(todos.filter((item) => item.id !== id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to remove the todo note.");
    }
  }

  async function chooseTemplate(nextPath: string) {
    try {
      await saveValues({ templatePath: nextPath });
      setTemplateOpen(false);
      toast.show(nextPath ? "Template saved." : "Using the built-in standup template.", {
        variant: "success",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the template.");
    }
  }

  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <Text style={styles.title}>Standup</Text>
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Select standup folder"
            onPress={() => {
              void openBrowser();
            }}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryButtonText}>Select</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Choose an Obsidian template"
            onPress={() => {
              setTemplateOpen(true);
              void refreshTemplates(folderPath || vaultPath);
            }}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonText}>Template</Text>
          </Pressable>
          {folderPath ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Update today’s standup note"
              onPress={() => {
                void updateExistingFolder();
              }}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>Update note</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      <View style={styles.body}>
        <View style={styles.main}>
          <Text style={styles.hint}>
            {detectedLabel
              ? `Select opens in the “${detectedLabel}” vault so you can pick a folder.`
              : "Choose a folder. Today’s note is created or updated there."}
          </Text>
          <Text style={styles.path} numberOfLines={2}>
            {folderPath || "No folder selected yet."}
          </Text>
          <Text style={styles.note} numberOfLines={1}>
            Template: {selectedTemplate?.name ?? (templatePath ? templatePath : "Built-in standup")}
          </Text>
          {notePath ? (
            <Text style={styles.note} numberOfLines={2}>
              {notePath}
            </Text>
          ) : null}

          <View style={styles.group}>
            <Text style={styles.groupTitle}>Work · DCE</Text>
            <Text style={styles.label}>STORIES · {work.items.length}</Text>
            {work.error ? <Text style={styles.danger}>{work.error}</Text> : null}
            {work.items.length === 0 && !work.error ? (
              <Text style={styles.hint}>No DCE stories assigned to you.</Text>
            ) : (
              work.items.map((item) => (
                <Pressable
                  key={item.key}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${item.key} ${item.summary}`}
                  onPress={() => {
                    void openExternalUrl(item.url);
                  }}
                  style={styles.prRow}
                >
                  <Text style={styles.prKey}>{item.key}</Text>
                  <Text style={styles.prTitle} numberOfLines={2}>
                    {item.summary}
                  </Text>
                  <Text style={item.statusCategory === "done" ? styles.note : styles.workStatus}>
                    {item.status}
                  </Text>
                </Pressable>
              ))
            )}
            <MergedList
              label={`MERGED TODAY${merged.date ? ` · ${merged.date}` : ""}`}
              prs={workPrs}
              error={merged.error}
              empty="No DCE pull requests merged today."
              styles={styles}
            />
          </View>

          <View style={styles.groupDivider} />

          <View style={styles.group}>
            <Text style={styles.groupTitle}>Personal projects</Text>
            <MergedList
              label={`MERGED TODAY${merged.date ? ` · ${merged.date}` : ""}`}
              prs={personalPrs}
              error={merged.error}
              empty="No personal pull requests merged today."
              styles={styles}
            />
          </View>
        </View>

        <View style={styles.todoPane}>
          <Text style={styles.todoTitle}>Todo notes</Text>
          <Text style={styles.hint}>
            {folderPath
              ? "Saved into today’s selected Obsidian note."
              : "Select a folder to write todos into the daily note."}
          </Text>
          <View style={styles.todoSplit}>
            <View style={styles.todoComposer}>
              <View style={styles.kindRow}>
                {(["todo", "blocker", "note"] as const).map((kind) => {
                  const selected = todoKind === kind;
                  return (
                    <Pressable
                      key={kind}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`Add as ${kind}`}
                      onPress={() => {
                        setTodoKind(kind);
                      }}
                      style={selected ? styles.kindSelected : styles.kindButton}
                    >
                      <Text style={selected ? styles.kindSelectedText : styles.kindText}>
                        {kindLabel(kind)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <TextInput
                accessibilityLabel="Todo note text"
                placeholder={todoPlaceholder(todoKind)}
                placeholderTextColor={theme.colors.foregroundMuted}
                value={todoDraft}
                onChangeText={setTodoDraft}
                multiline
                textAlignVertical="top"
                blurOnSubmit={false}
                style={styles.todoInput}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Add ${todoKind} to today’s note`}
                disabled={!folderPath || todoBusy || todoDraft.trim().length === 0}
                onPress={() => {
                  void addTodo();
                }}
                style={styles.primaryButton}
              >
                <Text style={styles.primaryButtonText}>
                  {todoBusy ? "Saving…" : `Add ${todoKind}`}
                </Text>
              </Pressable>
            </View>
            <ScrollView style={styles.todoList} contentContainerStyle={styles.todoListContent}>
              {todos.length === 0 ? (
                <Text style={styles.hint}>No extra notes on today’s file yet.</Text>
              ) : (
                todos.map((item) => (
                  <View key={item.id} style={styles.todoRow}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ checked: item.done }}
                      accessibilityLabel={`${item.done ? "Mark incomplete" : "Mark done"}: ${item.text}`}
                      onPress={() => {
                        void toggleTodo(item.id);
                      }}
                      style={item.done ? styles.todoCheckDone : styles.todoCheck}
                    >
                      <Text style={item.done ? styles.todoCheckDoneText : styles.todoCheckText}>
                        {item.done ? "✓" : ""}
                      </Text>
                    </Pressable>
                    <View style={styles.todoBody}>
                      <Text style={item.kind === "blocker" ? styles.todoKindDanger : styles.todoKind}>
                        {kindLabel(item.kind)}
                      </Text>
                      <Text style={item.done ? styles.todoTextDone : styles.todoText}>{item.text}</Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${item.kind} ${item.text}`}
                      onPress={() => {
                        void removeTodo(item.id);
                      }}
                      style={styles.todoRemove}
                    >
                      <Text style={styles.todoRemoveText}>Remove</Text>
                    </Pressable>
                  </View>
                ))
              )}
            </ScrollView>
          </View>
        </View>
      </View>

      <Modal
        title="Select standup folder"
        icon={<Icon name="FolderOpen" size={18} color={theme.colors.foreground} />}
        open={browseOpen}
        onOpenChange={setBrowseOpen}
      >
        <Modal.Content
          scrollable={false}
          style={{ backgroundColor: theme.colors.surface1 }}
          contentContainerStyle={{ padding: 0, gap: 0 }}
        >
          <View style={styles.browser}>
            <Text style={styles.browserPath} numberOfLines={2}>
              {listing?.path ?? "Loading…"}
            </Text>
            {browseError ? <Text style={styles.danger}>{browseError}</Text> : null}
            <View style={styles.browserActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Go to parent folder"
                disabled={!listing?.parent || busy}
                onPress={() => {
                  if (listing?.parent) {
                    void loadFolder(listing.parent);
                  }
                }}
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryButtonText}>Up</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Use this folder for standup notes"
                disabled={!listing || busy}
                onPress={() => {
                  if (listing) {
                    void saveFolderAndUpdate(listing.path);
                  }
                }}
                style={styles.primaryButton}
              >
                <Text style={styles.primaryButtonText}>
                  {busy ? "Working…" : "Use this folder"}
                </Text>
              </Pressable>
            </View>
            <FlatList
              style={styles.folderList}
              data={listing?.entries ?? []}
              keyExtractor={(item) => item.path}
              renderItem={({ item }) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open folder ${item.name}`}
                  onPress={() => {
                    void loadFolder(item.path);
                  }}
                  style={styles.folderRow}
                >
                  <Text style={styles.folderName}>{item.name}</Text>
                </Pressable>
              )}
              ListEmptyComponent={
                <Text style={styles.hint}>{busy ? "Loading folders…" : "No subfolders."}</Text>
              }
            />
          </View>
        </Modal.Content>
      </Modal>

      <Modal
        title="Obsidian template"
        icon={<Icon name="FileText" size={18} color={theme.colors.foreground} />}
        open={templateOpen}
        onOpenChange={setTemplateOpen}
      >
        <Modal.Content
          scrollable={false}
          style={{ backgroundColor: theme.colors.surface1 }}
          contentContainerStyle={{ padding: 0, gap: 0 }}
        >
          <View style={styles.browser}>
            <Text style={styles.hint}>
              New notes use this template. Existing notes are left as they are, except for the
              Shipped section.
            </Text>
            {templates.suggestedPath ? (
              <Text style={styles.hint}>
                Suggested for this folder:{" "}
                {templates.templates.find((template) => template.path === templates.suggestedPath)
                  ?.name ?? "Standup"}
              </Text>
            ) : null}
            <FlatList
              style={styles.folderList}
              data={[
                { name: "Built-in standup", path: "" },
                ...templates.templates,
              ]}
              keyExtractor={(item) => item.path || "built-in"}
              renderItem={({ item }) => {
                const selected = item.path === templatePath;
                const suggested = item.path.length > 0 && item.path === templates.suggestedPath;
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`Use template ${item.name}`}
                    onPress={() => {
                      void chooseTemplate(item.path);
                    }}
                    style={styles.folderRow}
                  >
                    <Text style={styles.folderName}>
                      {item.name}
                      {selected ? " · selected" : ""}
                      {suggested && !selected ? " · suggested" : ""}
                    </Text>
                  </Pressable>
                );
              }}
              ListEmptyComponent={<Text style={styles.hint}>No vault templates found.</Text>}
            />
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}

function MergedList({
  label,
  prs,
  error,
  empty,
  styles,
}: {
  label: string;
  prs: MergedPr[];
  error: string | null;
  empty: string;
  styles: StandupStyles;
}) {
  return (
    <>
      <Text style={styles.label}>
        {label} · {prs.length}
      </Text>
      {error ? <Text style={styles.danger}>{error}</Text> : null}
      {prs.length === 0 && !error ? (
        <Text style={styles.hint}>{empty}</Text>
      ) : (
        prs.map((pr) => (
          <Pressable
            key={`${pr.repo}-${pr.number}`}
            accessibilityRole="button"
            accessibilityLabel={`Open pull request ${pr.number} ${pr.title}`}
            onPress={() => {
              void openExternalUrl(pr.url);
            }}
            style={styles.prRow}
          >
            <Text style={styles.prKey}>{pr.key || `#${pr.number}`}</Text>
            <Text style={styles.prTitle} numberOfLines={2}>
              {pr.title}
            </Text>
            <Text style={styles.note} numberOfLines={1}>
              {pr.repo ? `${pr.repo.split("/").pop()} ` : ""}#{pr.number}
            </Text>
          </Pressable>
        ))
      )}
    </>
  );
}

function kindLabel(kind: StandupTodoKind) {
  return kind === "todo" ? "Todo" : kind === "blocker" ? "Blocker" : "Note";
}

function todoPlaceholder(kind: StandupTodoKind) {
  if (kind === "blocker") {
    return "What’s blocking today?";
  }
  if (kind === "note") {
    return "Additional note for the file";
  }
  return "What needs to get done?";
}

function createStyles(theme: PluginSurfaceProps["theme"], compact: boolean) {
  return {
    section: {
      gap: 8,
      padding: compact ? 14 : 18,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    head: {
      flexDirection: compact ? ("column" as const) : ("row" as const),
      alignItems: compact ? ("stretch" as const) : ("center" as const),
      justifyContent: "space-between" as const,
      gap: 8,
    },
    title: {
      color: theme.colors.foreground,
      fontSize: compact ? 16 : 18,
      fontWeight: "600" as const,
    },
    body: {
      flexDirection: compact ? ("column" as const) : ("row" as const),
      alignItems: "stretch" as const,
      gap: compact ? 12 : 16,
    },
    main: {
      flexGrow: compact ? 0 : 2,
      flexShrink: 1,
      flexBasis: compact ? ("auto" as const) : 0,
      minWidth: 0,
      gap: 8,
    },
    todoPane: {
      flexGrow: compact ? 0 : 3,
      flexShrink: 1,
      flexBasis: compact ? ("auto" as const) : 0,
      width: compact ? ("100%" as const) : undefined,
      minWidth: 0,
      gap: 8,
      padding: compact ? 12 : 14,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    },
    todoTitle: {
      color: theme.colors.foreground,
      fontSize: 14,
      fontWeight: "600" as const,
    },
    todoSplit: {
      flexDirection: compact ? ("column" as const) : ("row" as const),
      alignItems: "stretch" as const,
      gap: 12,
      minHeight: compact ? undefined : 220,
    },
    todoComposer: {
      flexGrow: compact ? 0 : 2,
      flexShrink: 1,
      flexBasis: compact ? ("auto" as const) : 0,
      minWidth: 0,
      gap: 8,
    },
    todoList: {
      flexGrow: compact ? 0 : 3,
      flexShrink: 1,
      flexBasis: compact ? ("auto" as const) : 0,
      minWidth: 0,
      minHeight: compact ? 140 : 0,
    },
    todoListContent: {
      gap: 0,
    },
    kindRow: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: 6,
    },
    kindButton: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    kindSelected: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 999,
      backgroundColor: theme.colors.accent,
    },
    kindText: {
      color: theme.colors.foreground,
      fontSize: 12,
    },
    kindSelectedText: {
      color: theme.colors.accentForeground,
      fontSize: 12,
    },
    todoInput: {
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface1,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingVertical: 10,
      fontSize: 13,
      minHeight: compact ? 96 : 160,
      flexGrow: compact ? 0 : 1,
    },
    todoRow: {
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      gap: 10,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    todoCheck: {
      width: 28,
      height: 28,
      borderRadius: 8,
      borderWidth: 1.5,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      marginTop: 2,
    },
    todoCheckDone: {
      width: 28,
      height: 28,
      borderRadius: 8,
      borderWidth: 1.5,
      borderColor: theme.colors.accent,
      backgroundColor: theme.colors.accent,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      marginTop: 2,
    },
    todoCheckText: {
      color: theme.colors.foregroundMuted,
      fontSize: 16,
      lineHeight: 18,
    },
    todoCheckDoneText: {
      color: theme.colors.accentForeground,
      fontSize: 16,
      lineHeight: 18,
      fontWeight: "700" as const,
    },
    todoBody: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    todoKind: {
      color: theme.colors.foregroundMuted,
      fontSize: 10,
      letterSpacing: 0.4,
    },
    todoKindDanger: {
      color: theme.colors.statusDanger,
      fontSize: 10,
      letterSpacing: 0.4,
    },
    todoText: {
      color: theme.colors.foreground,
      fontSize: 13,
    },
    todoTextDone: {
      color: theme.colors.foregroundMuted,
      fontSize: 13,
      textDecorationLine: "line-through" as const,
    },
    todoRemove: {
      paddingVertical: 2,
    },
    todoRemoveText: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
    },
    group: {
      gap: 8,
    },
    groupTitle: {
      color: theme.colors.foreground,
      fontSize: 14,
      fontWeight: "600" as const,
      marginTop: 8,
    },
    groupDivider: {
      height: 1,
      marginTop: 8,
      backgroundColor: theme.colors.border,
    },
    label: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      letterSpacing: 0.8,
      marginTop: 8,
    },
    hint: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    path: {
      color: theme.colors.foreground,
    },
    note: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    actions: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: 8,
    },
    primaryButton: {
      alignSelf: "flex-start" as const,
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: 999,
      backgroundColor: theme.colors.accent,
    },
    primaryButtonText: {
      color: theme.colors.accentForeground,
      fontSize: 12,
    },
    secondaryButton: {
      alignSelf: "flex-start" as const,
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    },
    secondaryButtonText: {
      color: theme.colors.foreground,
      fontSize: 12,
    },
    browser: {
      flex: 1,
      minHeight: 0,
      padding: compact ? 12 : 16,
      gap: 10,
    },
    browserPath: {
      color: theme.colors.foreground,
    },
    browserActions: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: 8,
    },
    folderList: {
      flex: 1,
      minHeight: 0,
    },
    folderRow: {
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    folderName: {
      color: theme.colors.foreground,
    },
    danger: {
      color: theme.colors.statusDanger,
    },
    prRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 10,
      paddingVertical: 10,
      paddingHorizontal: compact ? 12 : 14,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    },
    prKey: {
      color: theme.colors.foregroundMuted,
      minWidth: 72,
    },
    prTitle: {
      color: theme.colors.foreground,
      flex: 1,
    },
    workStatus: {
      color: theme.colors.foreground,
      fontSize: 12,
    },
  };
}
