import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { interpretRows, type InterpretEntry } from "./voice-interpret-model";

// The Voice helper's switch and its last few utterances: what was heard next to what the helper
// made of it. A thin view over client/voice-interpret-model.ts; all logic lives there.

type Theme = PluginSurfaceProps["theme"];
type Styles = ReturnType<typeof createStyles>;

export function VoiceInterpretPanel({
  theme,
  enabled,
  onToggle,
  history,
}: {
  theme: Theme;
  enabled: boolean;
  onToggle(next: boolean): void;
  history: InterpretEntry[];
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const rows = interpretRows(history);

  return (
    <View style={styles.box}>
      <View style={styles.head}>
        <Text style={[styles.title, styles.flex]}>Voice helper</Text>
        <Pressable
          accessibilityRole="switch"
          accessibilityLabel="Voice helper"
          accessibilityState={{ checked: enabled }}
          onPress={() => onToggle(!enabled)}
          style={[styles.track, enabled ? styles.trackOn : null]}
        >
          <View style={[styles.thumb, enabled ? styles.thumbOn : null]} />
        </Pressable>
      </View>

      {rows.map((row) => (
        <View key={row.key} style={styles.row}>
          <View style={styles.pair}>
            <View style={styles.flex}>
              <Text style={styles.hint}>heard</Text>
              <Text style={styles.text}>{row.heard}</Text>
            </View>
            <Text style={styles.hint}>{"→"}</Text>
            <View style={styles.flex}>
              <Text style={styles.hint}>cleaned</Text>
              <Text style={styles.text}>{row.cleaned}</Text>
            </View>
          </View>
          {row.note ? <Text style={styles.note}>{row.note}</Text> : null}
        </View>
      ))}
    </View>
  );
}

function createStyles(theme: Theme) {
  const c = theme.colors;
  return {
    box: { gap: 10, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface0 },
    head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    flex: { flex: 1, minWidth: 0 },
    title: { color: c.foreground, fontSize: 13, fontWeight: "600" as const },
    track: { width: 36, height: 20, borderRadius: 10, padding: 2, justifyContent: "center" as const, backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border },
    trackOn: { backgroundColor: c.accent, borderColor: c.accent },
    thumb: { width: 14, height: 14, borderRadius: 7, backgroundColor: c.foregroundMuted },
    thumbOn: { alignSelf: "flex-end" as const, backgroundColor: c.accentForeground },
    row: { gap: 4, paddingTop: 10, borderTopWidth: 1, borderTopColor: c.border },
    pair: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    hint: { color: c.foregroundMuted, fontSize: 11.5 },
    text: { color: c.foreground, fontSize: 12.5 },
    note: { color: c.statusWarning, fontSize: 11.5 },
  };
}
