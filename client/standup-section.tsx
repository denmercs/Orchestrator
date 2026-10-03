import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { openExternalUrl, useRpc, useSettings } from "@getpaseo/plugin/client";
import { FlatList, Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import {
  detectOrchestrationObsidian,
  listOrchestrationFolders,
  listOrchestrationMergedPrs,
  listOrchestrationTemplates,
  upsertOrchestrationStandupNote,
} from "../shared/orchestration";
import { standupSettings } from "../shared/settings";

type FolderListing = RpcOutput<typeof listOrchestrationFolders>;
type TemplateListing = RpcOutput<typeof listOrchestrationTemplates>;
type MergedListing = RpcOutput<typeof listOrchestrationMergedPrs>;

export function StandupSection({
  theme,
  layout,
}: Pick<PluginSurfaceProps, "theme" | "layout">) {
  const settings = useSettings(standupSettings);
  const listFolders = useRpc(listOrchestrationFolders);
  const listTemplates = useRpc(listOrchestrationTemplates);
  const listMerged = useRpc(listOrchestrationMergedPrs);
  const upsertNote = useRpc(upsertOrchestrationStandupNote);
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
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const folderPath = settings.status === "ready" ? settings.values.standupFolder : "";
  const templatePath = settings.status === "ready" ? settings.values.templatePath : "";
  const selectedTemplate =
    templates.templates.find((template) => template.path === templatePath) ?? null;

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
    void listMerged({})
      .then(setMerged)
      .catch((error) => {
        setMerged({
          date: "",
          prs: [],
          error: error instanceof Error ? error.message : "Unable to list merged pull requests.",
        });
      });
  }, [listMerged]);

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
        <Text style={styles.label}>STANDUP</Text>
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

      <Text style={styles.label}>
        MERGED TODAY{merged.date ? ` · ${merged.date}` : ""} · {merged.prs.length}
      </Text>
      {merged.error ? <Text style={styles.danger}>{merged.error}</Text> : null}
      {merged.prs.length === 0 && !merged.error ? (
        <Text style={styles.hint}>No pull requests merged today.</Text>
      ) : (
        merged.prs.map((pr) => (
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
            <Text style={styles.note}>#{pr.number}</Text>
          </Pressable>
        ))
      )}

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

function createStyles(theme: PluginSurfaceProps["theme"], compact: boolean) {
  return {
    section: {
      gap: 8,
    },
    head: {
      flexDirection: compact ? ("column" as const) : ("row" as const),
      alignItems: compact ? ("stretch" as const) : ("center" as const),
      justifyContent: "space-between" as const,
      gap: 8,
    },
    label: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      letterSpacing: 0.8,
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
      backgroundColor: theme.colors.surface1,
    },
    prKey: {
      color: theme.colors.foregroundMuted,
      minWidth: 72,
    },
    prTitle: {
      color: theme.colors.foreground,
      flex: 1,
    },
  };
}
