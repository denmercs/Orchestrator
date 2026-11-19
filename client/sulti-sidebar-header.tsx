import { useCallback, useEffect, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { sultiSidebarSettings } from "../shared/settings";
import { hasUnread, replyFingerprint } from "./sulti-sidebar-model";
import { previewText } from "./sulti-strip-model";
import { useSultiStrip } from "./use-sulti-strip";

const CHAT_SCREEN = "sulti-chat";

export function SultiSidebarHeader({ theme, layout, openScreen }: PluginSidebarItemProps) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const sidebar = useSettings(sultiSidebarSettings);
  const toast = useToast();
  const { reading, text, setText, busy, status, sendEnabled, submit } = useSultiStrip();

  const minimized = sidebar.status === "ready" ? sidebar.values.minimized : false;
  const lastSeen = sidebar.status === "ready" ? sidebar.values.lastSeenReply : "";
  const reply = reading.reply;
  const unread = hasUnread(reply, lastSeen);
  const sultiId = reading.sultiId;

  const markSeen = useCallback(
    async (fp: string) => {
      if (sidebar.status !== "ready" || fp === sidebar.values.lastSeenReply) return;
      const saved = await sidebar.save({ ...sidebar.values, lastSeenReply: fp }, sidebar.revision);
      if (!saved) toast.error(sidebar.saveError ?? "Could not save Sulti sidebar state.");
    },
    [sidebar, toast],
  );

  useEffect(() => {
    if (minimized) return;
    const fp = replyFingerprint(reply);
    if (fp) void markSeen(fp);
  }, [minimized, reply, markSeen]);

  async function setMinimized(next: boolean) {
    if (sidebar.status !== "ready") return;
    const fp = replyFingerprint(reply);
    const values = { ...sidebar.values, minimized: next };
    if (!next && fp) values.lastSeenReply = fp;
    const saved = await sidebar.save(values, sidebar.revision);
    if (!saved) toast.error(sidebar.saveError ?? "Could not save Sulti sidebar state.");
  }

  function openChat() {
    if (!sultiId) return;
    openScreen({ screenId: CHAT_SCREEN, params: { agentId: sultiId } });
  }

  if (minimized) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={unread ? "Sulti, unread" : "Sulti"}
        onPress={() => void setMinimized(false)}
        style={styles.chip}
      >
        <Text style={styles.chipLabel}>Sulti</Text>
        {unread ? <View style={styles.dot} /> : null}
      </Pressable>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>Sulti</Text>
        <View style={styles.titleActions}>
          {unread ? <View style={styles.dot} /> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Minimize Sulti"
            onPress={() => void setMinimized(true)}
            style={styles.iconButton}
          >
            <Icon name="Minus" size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
      </View>
      <Text style={styles.reply} numberOfLines={3}>
        {previewText(reply)}
      </Text>
      {reading.error ? <Text style={styles.error}>{reading.error}</Text> : null}
      <View style={styles.row}>
        <TextInput
          accessibilityLabel="Tell Sulti something"
          placeholder="Tell Sulti something"
          placeholderTextColor={theme.colors.foregroundMuted}
          value={text}
          onChangeText={setText}
          onSubmitEditing={() => void submit()}
          editable={!busy}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: !sendEnabled }}
          disabled={!sendEnabled}
          onPress={() => void submit()}
          style={[styles.button, sendEnabled ? null : styles.disabled]}
        >
          <Text style={styles.buttonText}>{busy ? "Sending…" : "Send"}</Text>
        </Pressable>
      </View>
      {sultiId ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Open in Paseo chat" onPress={openChat} style={styles.linkButton}>
          <Text style={styles.linkText}>Open in Paseo chat</Text>
        </Pressable>
      ) : null}
      {status ? <Text style={styles.status}>{status}</Text> : null}
    </View>
  );
}

function createStyles(theme: PluginSidebarItemProps["theme"], compact: boolean) {
  const c = theme.colors;
  return {
    card: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      backgroundColor: c.surface1,
      gap: 8,
      paddingVertical: 10,
      paddingHorizontal: compact ? 10 : 12,
      marginBottom: 8,
    },
    titleRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
    },
    title: { fontSize: 12, fontWeight: "600" as const, color: c.foregroundMuted },
    titleActions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    iconButton: { padding: 4 },
    reply: { fontSize: compact ? 13.5 : 12.5, color: c.foreground },
    error: { fontSize: 11.5, color: c.statusDanger },
    row: { flexDirection: "column" as const, gap: 8 },
    input: {
      minWidth: 0,
      height: 44,
      paddingVertical: 0,
      paddingHorizontal: 10,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 6,
      backgroundColor: c.surface0,
      color: c.foreground,
      fontSize: compact ? 15 : 13,
    },
    button: {
      height: 44,
      paddingHorizontal: 14,
      borderRadius: 6,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      backgroundColor: c.accent,
    },
    buttonText: { fontSize: compact ? 14 : 12.5, fontWeight: "600" as const, color: c.surface0 },
    disabled: { opacity: 0.5 },
    linkButton: {
      height: 36,
      alignItems: "flex-start" as const,
      justifyContent: "center" as const,
    },
    linkText: { fontSize: 12.5, fontWeight: "600" as const, color: c.accent },
    status: { fontSize: 11.5, color: c.foregroundMuted },
    chip: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      alignSelf: "flex-start" as const,
      gap: 6,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 999,
      backgroundColor: c.surface1,
      paddingVertical: 6,
      paddingHorizontal: 12,
      marginBottom: 8,
    },
    chipLabel: { fontSize: 12.5, fontWeight: "600" as const, color: c.foreground },
    dot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: c.accent,
    },
  };
}