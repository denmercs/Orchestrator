import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { gateRowLabel, waitingLabel, type Gate } from "../shared/gates";
import { createAlertsBellStyles } from "./alerts-bell-styles";

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
  theme: PluginSurfaceProps["theme"];
  compact: boolean;
  gates: Gate[];
  open: boolean;
  onOpenChange(open: boolean): void;
  onOpenGate(gate: Gate): void;
}) {
  const styles = useMemo(() => createAlertsBellStyles(theme, compact), [theme, compact]);
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
                  accessibilityLabel={gateRowLabel(gate)}
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
