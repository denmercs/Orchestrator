import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { gateRow, gateRowLabel, waitingLabel, type Gate } from "../shared/gates";
import { createAlertsBellStyles } from "./alerts-bell-styles";
import { gateKey, useGateActions } from "./use-gate-actions";

// The header bell: a count of gates waiting on you, and a popover listing them with the actions you can take
// on each. The dashboard owns `open` so its full-screen backdrop can close the popover on an outside press.
export function AlertsBell({
  theme,
  compact,
  gates,
  navigation,
  open,
  onOpenChange,
  onOpenGate,
  onActed,
}: {
  theme: PluginSurfaceProps["theme"];
  compact: boolean;
  gates: Gate[];
  navigation: PluginSurfaceProps["navigation"];
  open: boolean;
  onOpenChange(open: boolean): void;
  onOpenGate(gate: Gate): void;
  onActed(): Promise<void>;
}) {
  const styles = useMemo(() => createAlertsBellStyles(theme, compact), [theme, compact]);
  const label = waitingLabel(gates.length);
  const { run, isBusy } = useGateActions({ navigation, onActed });
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
              {gates.map((gate) => {
                const row = gateRow(gate);
                const disabled = isBusy(gate);
                return (
                  <View key={gateKey(gate)} style={styles.row}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={gateRowLabel(gate)}
                      onPress={() => onOpenGate(gate)}
                      style={styles.rowBody}
                    >
                      <View style={styles.dot} />
                      <View style={styles.rowText}>
                        <Text style={styles.gateText}>
                          <Text style={styles.tag}>{row.tag}</Text> {row.text}
                        </Text>
                        <Text style={styles.where}>{row.where}</Text>
                      </View>
                    </Pressable>
                    <View style={styles.buttons}>
                      {row.secondary ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`${row.secondary.label}, ${row.tag}`}
                          disabled={disabled}
                          onPress={() => row.secondary && void run(gate, row.secondary)}
                          style={[styles.button, styles.secondary, disabled ? styles.disabled : null]}
                        >
                          <Text style={styles.secondaryText}>{row.secondary.label}</Text>
                        </Pressable>
                      ) : null}
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${row.primary.label}, ${row.tag}`}
                        disabled={disabled}
                        onPress={() => void run(gate, row.primary)}
                        style={[styles.button, styles.primary, disabled ? styles.disabled : null]}
                      >
                        <Text style={styles.primaryText}>{row.primary.label}</Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
