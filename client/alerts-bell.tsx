import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { waitingLabel, type Gate } from "../shared/gates";

type Theme = PluginSurfaceProps["theme"];

// The header bell: a count of gates waiting on you, and a popover listing them. The dashboard owns `open`
// so its full-screen backdrop can close the popover on an outside press.
export function AlertsBell({
  theme,
  compact,
  gates,
  open,
  onOpenChange,
  onOpenGate,
}: {
  theme: Theme;
  compact: boolean;
  gates: Gate[];
  open: boolean;
  onOpenChange(open: boolean): void;
  onOpenGate(gate: Gate): void;
}) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const label = waitingLabel(gates.length);
  return (
    <View style={styles.anchor}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Alerts, ${label}`}
        onPress={() => onOpenChange(!open)}
        style={[styles.bell, open ? styles.bellOn : null]}
      >
        <Icon name="Bell" size={16} color={theme.colors.foreground} />
        {gates.length > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{gates.length}</Text>
          </View>
        ) : null}
      </Pressable>
      {open ? (
        <View style={styles.popover}>
          <View style={styles.popoverHeader}>
            <Text style={styles.title}>Alerts</Text>
            <Text style={styles.subtitle}>{label}</Text>
          </View>
          {gates.length > 0 ? (
            <ScrollView style={styles.list}>
              {gates.map((gate) => (
                <Pressable
                  key={`${gate.board}\n${gate.storyId}`}
                  accessibilityRole="button"
                  onPress={() => onOpenGate(gate)}
                  style={styles.row}
                >
                  <View style={styles.dot} />
                  <View style={styles.rowText}>
                    <Text style={styles.gateText}>{gate.text}</Text>
                    <Text style={styles.where}>{gate.where}</Text>
                  </View>
                </Pressable>
              ))}
            </ScrollView>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function createStyles(theme: Theme, compact: boolean) {
  const c = theme.colors;
  return {
    anchor: { position: "relative" as const },
    bell: {
      width: 30,
      height: 30,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 7,
      backgroundColor: "transparent",
    },
    bellOn: { borderColor: c.accent, backgroundColor: c.surface2 },
    badge: {
      position: "absolute" as const,
      top: -6,
      right: -6,
      minWidth: 16,
      height: 16,
      paddingHorizontal: 4,
      borderRadius: 8,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      backgroundColor: c.statusWarning,
    },
    badgeText: { color: c.surface0, fontSize: 10, fontWeight: "700" as const },
    popover: {
      position: "absolute" as const,
      top: 36,
      left: 0,
      width: 340,
      maxWidth: compact ? ("100%" as const) : undefined,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      backgroundColor: c.surface1,
      overflow: "hidden" as const,
    },
    popoverHeader: {
      gap: 2,
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    title: { color: c.foreground, fontSize: 14, fontWeight: "600" as const },
    subtitle: { color: c.foregroundMuted, fontSize: 12 },
    // About six rows before it scrolls.
    list: { maxHeight: 330 },
    row: {
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    dot: { width: 8, height: 8, borderRadius: 4, marginTop: 5, backgroundColor: c.statusWarning },
    rowText: { flex: 1, gap: 2 },
    gateText: { color: c.foreground, fontSize: 13 },
    where: { color: c.foregroundMuted, fontSize: 12 },
  };
}
