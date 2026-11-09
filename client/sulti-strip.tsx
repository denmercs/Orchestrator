import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { sultiStripRead, sultiStripSend } from "../shared/sulti-strip";
import { SULTI_STRIP_POLL_MS } from "../shared/timing";
import { canSend, previewText, statusLine } from "./sulti-strip-model";

type Theme = PluginSurfaceProps["theme"];
type Reading = { sultiId: string | null; reply: string | null; error: string | null };

// The Sulti strip under the dashboard header, on every tab (see CONTEXT.md, "Sulti strip"). It
// shows Sulti's latest reply (plain text, clipped), sends typed text through the Sulti router and
// opens the Sulti chat in Paseo. It reads on mount, every 10 s while mounted, and right after a send.
export function SultiStrip({
  theme,
  compact,
  navigation,
}: {
  theme: Theme;
  compact: boolean;
  navigation: PluginSurfaceProps["navigation"];
}) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const read = useRpc(sultiStripRead);
  const send = useRpc(sultiStripSend);
  const toast = useToast();
  const [reading, setReading] = useState<Reading>({ sultiId: null, reply: null, error: null });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const mounted = useRef(true);
  const sendEnabled = canSend(text, busy);

  const refresh = useCallback(async () => {
    try {
      const next = await read({});
      if (mounted.current) setReading(next);
    } catch (cause) {
      if (mounted.current) {
        setReading((prev) => ({
          ...prev,
          error: cause instanceof Error ? cause.message : "Could not read Sulti.",
        }));
      }
    }
  }, [read]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), SULTI_STRIP_POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  async function submit() {
    if (!canSend(text, busy)) return;
    setBusy(true);
    try {
      const result = await send({ text });
      if (!mounted.current) return;
      setText("");
      setStatus(statusLine(result));
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not send to Sulti.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const sultiId = reading.sultiId;

  return (
    <View style={styles.card}>
      <Text style={styles.reply} numberOfLines={3}>
        {previewText(reading.reply)}
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
        {navigation && sultiId ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open in Paseo chat"
            onPress={() => navigation.openAgent({ agentId: sultiId })}
            style={styles.linkButton}
          >
            <Text style={styles.linkText}>Open in Paseo chat</Text>
          </Pressable>
        ) : null}
      </View>
      {status ? <Text style={styles.status}>{status}</Text> : null}
    </View>
  );
}

function createStyles(theme: Theme, compact: boolean) {
  const c = theme.colors;
  return {
    card: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      backgroundColor: c.surface1,
      gap: 8,
      paddingVertical: 10,
      paddingHorizontal: compact ? 12 : 16,
      marginBottom: 12,
    },
    reply: { fontSize: compact ? 13.5 : 12.5, color: c.foreground },
    error: { fontSize: 11.5, color: c.statusDanger },
    row: {
      flexDirection: compact ? ("column" as const) : ("row" as const),
      alignItems: compact ? ("stretch" as const) : ("center" as const),
      gap: compact ? 8 : 10,
    },
    input: {
      flex: compact ? undefined : 1,
      minWidth: 0,
      // A phone-sized touch target, and tall enough that the placeholder isn't clipped.
      height: compact ? 44 : 32,
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
      height: compact ? 44 : 32,
      paddingHorizontal: 14,
      borderRadius: 6,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      backgroundColor: c.accent,
    },
    buttonText: { fontSize: compact ? 14 : 12.5, fontWeight: "600" as const, color: c.surface0 },
    disabled: { opacity: 0.5 },
    linkButton: {
      height: compact ? 44 : 32,
      paddingHorizontal: 10,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    linkText: { fontSize: compact ? 14 : 12.5, fontWeight: "600" as const, color: c.accent },
    status: { fontSize: 11.5, color: c.foregroundMuted },
  };
}
