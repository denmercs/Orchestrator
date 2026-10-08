import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

type Theme = PluginSurfaceProps["theme"];

// Kept out of alerts-bell.tsx so tests can load it without react-native.
export function createAlertsBellStyles(theme: Theme, compact: boolean) {
  const c = theme.colors;
  return {
    // Above the header buttons that render after the bell, which would otherwise cover the popover.
    anchor: { position: "relative" as const, zIndex: 20 },
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
      zIndex: 20,
      elevation: 8,
      shadowColor: "#000",
      shadowOpacity: 0.3,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 6 },
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
