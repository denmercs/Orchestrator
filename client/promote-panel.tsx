import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { usePaseo, useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { promoteSessionToStory } from "../shared/promote";
import {
  initialPromoteForm,
  promoteInput,
  setPromoteKind,
  setPromoteTitle,
  setPromoteWorkspace,
  validatePromote,
  type PromoteForm,
  type PromoteKind,
} from "./promote-model";

type Theme = PluginScreenProps["theme"];
type PaseoApi = ReturnType<typeof usePaseo>;
type WorkspaceList = Awaited<ReturnType<PaseoApi["workspaces"]["list"]>>;
type Workspace = WorkspaceList["entries"][number];

const PAGE_LIMIT = 100;

// The screen opens via openScreen; its params carry the pre-filled title (from /promote <args>) and
// the workspace to default to. The pill passes `workspaceId`; the slash command passes both.
export function PromotePanel({ theme, layout, params, navigation }: PluginScreenProps) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const paseo = usePaseo();
  const promote = useRpc(promoteSessionToStory);

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [form, setForm] = useState<PromoteForm>(() =>
    initialPromoteForm({ defaultWorkspaceId: params.workspaceId ?? "", argsTitle: params.title }),
  );
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [done, setDone] = useState<{ ticketKey: string | null; agentId: string | null } | null>(null);

  // Live-load the workspace list so the dropdown stays current. Shallow release on unmount.
  useEffect(() => {
    let cancelled = false;
    let subscription: WorkspaceList["subscription"] | undefined;
    void paseo.workspaces
      .list({ subscribe: {}, page: { limit: PAGE_LIMIT } })
      .then((list) => {
        if (cancelled) {
          void list.subscription.release();
          return;
        }
        subscription = list.subscription;
        setWorkspaces(list.entries.filter((workspace) => !workspace.archivingAt));
        list.subscription.subscribe({
          snapshot: ({ entries }) => setWorkspaces(entries.filter((workspace) => !workspace.archivingAt)),
          update: () => {},
          error: () => {},
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      void subscription?.release();
    };
  }, [paseo]);

  const validation = validatePromote(form);
  const canSubmit = validation.ok && !submitting;

  async function submit() {
    if (!validation.ok || submitting) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const result = await promote(promoteInput(form));
      if (!result.ok) {
        setServerError(result.error ?? "Could not promote this session.");
        return;
      }
      setDone({ ticketKey: result.ticketKey, agentId: result.agentId });
    } catch (cause) {
      setServerError(cause instanceof Error ? cause.message : "Could not promote this session.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <View style={styles.screen}>
        <View style={styles.card}>
          <Text style={styles.title}>Promoted</Text>
          <Text style={styles.muted}>
            {done.ticketKey ? `Started ${done.ticketKey}.` : "Started a new story."}
            {done.agentId ? " The planning agent is live now." : ""}
          </Text>
          {done.agentId && navigation?.openAgent ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open the planning agent"
              onPress={() => {
                try {
                  navigation.openAgent?.({ agentId: done.agentId! });
                } catch {
                  // The agent closed between the mount and the tap; stay on this screen.
                }
              }}
              style={styles.primary}
            >
              <Text style={styles.primaryText}>Open the planning agent</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.scroll}>
      <View style={styles.card}>
        <Text style={styles.title}>Promote to a story</Text>
        <Text style={styles.muted}>
          Starts the Story pipeline on a scratch ticket. No Jira is involved; the ticket key is minted locally as
          PROMOTE-N for this workspace.
        </Text>

        <View style={styles.field}>
          <Text style={styles.label}>Workspace</Text>
          <WorkspacePicker
            workspaces={workspaces}
            value={form.workspaceId}
            onChange={(id) => setForm((current) => setPromoteWorkspace(current, id))}
            styles={styles}
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Title</Text>
          <TextInput
            accessibilityLabel="Story title"
            placeholder="What's the story?"
            placeholderTextColor={theme.colors.foregroundMuted}
            value={form.title}
            onChangeText={(text) => setForm((current) => setPromoteTitle(current, text))}
            autoCorrect={false}
            style={styles.input}
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Kind</Text>
          <View style={styles.toggle}>
            {(["story", "bug"] as const).map((kind) => (
              <KindChip
                key={kind}
                kind={kind}
                active={form.kind === kind}
                styles={styles}
                onPress={() => setForm((current) => setPromoteKind(current, kind))}
              />
            ))}
          </View>
        </View>

        {!validation.ok ? <Text style={[styles.muted, styles.danger]}>{validation.message}</Text> : null}
        {serverError ? <Text style={[styles.muted, styles.danger]}>{serverError}</Text> : null}

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Promote this session"
            disabled={!canSubmit}
            onPress={() => void submit()}
            style={[styles.primary, canSubmit ? null : styles.disabled]}
          >
            <Text style={styles.primaryText}>{submitting ? "Promoting…" : "Promote"}</Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}

type Styles = ReturnType<typeof createStyles>;

function WorkspacePicker({
  workspaces,
  value,
  onChange,
  styles,
}: {
  workspaces: Workspace[];
  value: string;
  onChange(id: string): void;
  styles: Styles;
}) {
  if (workspaces.length === 0) {
    return <Text style={styles.muted}>No workspaces found. Open one first, then promote.</Text>;
  }
  return (
    <View style={styles.toggle}>
      {workspaces.map((workspace) => (
        <Pressable
          key={workspace.id}
          accessibilityRole="button"
          accessibilityLabel={`Workspace ${workspace.title ?? workspace.id}`}
          accessibilityState={{ selected: workspace.id === value }}
          onPress={() => onChange(workspace.id)}
          style={[styles.chip, workspace.id === value ? styles.chipActive : null]}
        >
          <Text style={[styles.chipText, workspace.id === value ? styles.chipTextActive : null]}>
            {workspace.title ?? workspace.id}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function KindChip({
  kind,
  active,
  styles,
  onPress,
}: {
  kind: PromoteKind;
  active: boolean;
  styles: Styles;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={kind === "story" ? "Story" : "Bug"}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.chip, active ? styles.chipActive : null]}
    >
      <Text style={[styles.chipText, active ? styles.chipTextActive : null]}>
        {kind === "story" ? "Story" : "Bug"}
      </Text>
    </Pressable>
  );
}

function createStyles(theme: Theme, compact: boolean) {
  const c = theme.colors;
  const pad = compact ? 16 : 24;
  return {
    screen: { flex: 1, backgroundColor: c.surface0 },
    scroll: { padding: pad, gap: 16 },
    card: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      backgroundColor: c.surface1,
      padding: pad,
      gap: 14,
    },
    title: { color: c.foreground, fontSize: compact ? 18 : 20, fontWeight: "600" as const },
    muted: { color: c.foregroundMuted, fontSize: 12 },
    danger: { color: c.statusDanger },
    field: { gap: 6 },
    label: { color: c.foregroundMuted, fontSize: 12, fontWeight: "600" as const },
    input: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      color: c.foreground,
      backgroundColor: c.surface0,
      fontSize: 14,
    },
    toggle: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
    chip: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 6,
      backgroundColor: c.surface0,
    },
    chipActive: { backgroundColor: c.surface2, borderColor: c.foregroundMuted },
    chipText: { color: c.foreground, fontSize: 12 },
    chipTextActive: { color: c.foreground, fontSize: 12, fontWeight: "600" as const },
    actions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, gap: 8 },
    primary: {
      backgroundColor: c.accent,
      borderRadius: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
      alignItems: "center" as const,
    },
    primaryText: { color: c.accentForeground, fontSize: 14, fontWeight: "600" as const },
    disabled: { opacity: 0.5 },
  };
}
