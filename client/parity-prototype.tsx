// PROTOTYPE — wipe me. Three layouts for a 1:1 iOS/Android parity panel, fed by MOCK_REPORT
// (shared/parity-prototype.ts). Opened from the story drawer's "Parity · prototype" button; flip
// layouts with the bar at the bottom or ← →. Once one wins, rewrite it properly and delete this.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  MOCK_REPORT,
  PLATFORMS,
  behind,
  byDimension,
  inParity,
  parityPanel,
  type Check,
  type ParityReport,
  type PanelSummary,
  type Platform,
  type Side,
} from "../shared/parity-prototype";

type Theme = PluginSurfaceProps["theme"];
type Styles = ReturnType<typeof createStyles>;
type VariantProps = { report: ParityReport; summary: PanelSummary; styles: Styles; theme: Theme };

const NAMES: Record<Platform, string> = { ios: "iOS · SwiftUI", android: "Android · Compose" };

const VARIANTS: readonly { key: string; name: string; render(props: VariantProps): ReactNode }[] = [
  { key: "A", name: "Matrix", render: (props) => <Matrix {...props} /> },
  { key: "B", name: "Mirror", render: (props) => <Mirror {...props} /> },
  { key: "C", name: "Drift inbox", render: (props) => <DriftInbox {...props} /> },
];

export function ParityPrototype({ theme, onClose }: { theme: Theme; onClose(): void }) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [index, setIndex] = useState(0);
  const report = MOCK_REPORT;
  const summary = useMemo(() => parityPanel(report), [report]);
  const step = (by: number) => setIndex((current) => (current + by + VARIANTS.length) % VARIANTS.length);

  // ← → cycle layouts on web, unless the user is typing.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA"].includes(target.tagName))) return;
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const variant = VARIANTS[index];
  return (
    <View style={styles.overlay}>
      <View style={styles.sheet}>
        <View style={styles.head}>
          <Text style={styles.proto}>PROTOTYPE</Text>
          <Text style={styles.storyId}>{report.storyId}</Text>
          <Text style={styles.title} numberOfLines={1}>
            {report.title}
          </Text>
          <View style={styles.flex} />
          <Text style={[styles.gate, { color: summary.gate.open ? theme.colors.statusSuccess : theme.colors.statusDanger }]}>
            {summary.gate.open ? "Merge gate open" : "Merge gate blocked"}
          </Text>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.button}>
            <Text style={styles.buttonText}>Close</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.body}>{variant.render({ report, summary, styles, theme })}</ScrollView>
      </View>
      <View style={styles.switcher}>
        <Pressable accessibilityRole="button" accessibilityLabel="Previous layout" onPress={() => step(-1)} style={styles.switchArrow}>
          <Text style={styles.switchText}>‹</Text>
        </Pressable>
        <Text style={styles.switchText}>
          {variant.key} — {variant.name}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Next layout" onPress={() => step(1)} style={styles.switchArrow}>
          <Text style={styles.switchText}>›</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ─── A · Matrix: one row per check, iOS and Android columns side by side, grouped by dimension.

function Matrix({ report, summary, styles, theme }: VariantProps) {
  return (
    <>
      <Text style={styles.muted}>
        {summary.green}/{summary.total} checks in parity · {summary.gate.reason}
      </Text>
      <CoreLine report={report} summary={summary} styles={styles} theme={theme} />
      <Screenshots report={report} styles={styles} theme={theme} />
      <View style={styles.table}>
        <View style={[styles.row, styles.rowHead]}>
          <Text style={[styles.cellName, styles.colHead]}>Check</Text>
          {PLATFORMS.map((platform) => (
            <Text key={platform} style={[styles.cellSide, styles.colHead]}>
              {NAMES[platform]}
            </Text>
          ))}
        </View>
        {byDimension(report).map((group) => (
          <View key={group.key}>
            <View style={styles.groupRow}>
              <Text style={styles.groupLabel}>{group.label.toUpperCase()}</Text>
              <Text style={styles.groupHint}>{group.hint}</Text>
              <View style={styles.flex} />
              <Text style={[styles.groupScore, { color: group.green === group.total ? theme.colors.statusSuccess : theme.colors.statusDanger }]}>
                {group.green}/{group.total}
              </Text>
            </View>
            {group.checks.map((check) => (
              <View key={check.id} style={[styles.row, !inParity(check) ? styles.rowDrift : null]}>
                <View style={styles.cellName}>
                  <Text style={styles.text}>{check.title}</Text>
                  {check.exception ? <Text style={styles.exception}>intentional difference</Text> : null}
                </View>
                {PLATFORMS.map((platform) => (
                  <View key={platform} style={styles.cellSide}>
                    <SideCell side={check[platform]} styles={styles} theme={theme} />
                  </View>
                ))}
              </View>
            ))}
          </View>
        ))}
      </View>
      <Files report={report} styles={styles} />
    </>
  );
}

// ─── B · Mirror: each platform is its own column, with a dimension spine down the middle.

function Mirror({ report, summary, styles, theme }: VariantProps) {
  const groups = byDimension(report);
  const column = (platform: Platform) => {
    const failing = report.checks.filter((check) => !check.exception && check[platform].status === "fail");
    const over = summary.visualOver.includes(platform);
    return (
      <View style={styles.mirrorCol}>
        <Text style={styles.mirrorHead}>{NAMES[platform]}</Text>
        <Text style={styles.muted}>{report.sharedCore[platform]}</Text>
        <View style={styles.phone}>
          <Text style={styles.phoneLabel}>{report.screenshots[platform]}</Text>
          <Text style={[styles.text, { color: over ? theme.colors.statusWarning : theme.colors.statusSuccess }]}>
            Δ {report.screenshots.diff[platform]}% vs RN
          </Text>
        </View>
        <Text style={styles.sectionLabel}>{failing.length ? `BEHIND ON ${failing.length}` : "NOTHING BEHIND"}</Text>
        {failing.map((check) => (
          <View key={check.id} style={styles.failItem}>
            <Text style={styles.text}>{check.title}</Text>
            <Text style={styles.failNote}>{check[platform].note}</Text>
          </View>
        ))}
        <Text style={styles.sectionLabel}>FILES</Text>
        {report.files.map((file) => (
          <Text key={file.area} style={styles.mono}>
            {file[platform]} +{platform === "ios" ? file.iosLines : file.androidLines}
          </Text>
        ))}
      </View>
    );
  };
  return (
    <View style={styles.mirror}>
      {column("ios")}
      <View style={styles.spine}>
        <Text style={styles.spineScore}>
          {summary.green}/{summary.total}
        </Text>
        {groups.map((group) => {
          const drift = group.checks.filter((check) => !inParity(check));
          const lean = drift.flatMap(behind);
          const arrow = lean.includes("ios") && lean.includes("android") ? "◀ ▶" : lean.includes("ios") ? "◀" : lean.includes("android") ? "▶" : "";
          return (
            <View key={group.key} style={[styles.spineChip, drift.length ? styles.spineDrift : null]}>
              <Text style={styles.spineArrow}>{arrow.startsWith("◀") ? "◀" : " "}</Text>
              <Text style={styles.spineLabel}>{group.label}</Text>
              <Text style={styles.spineArrow}>{arrow.endsWith("▶") ? "▶" : " "}</Text>
            </View>
          );
        })}
        <Text style={styles.spineHint}>◀ ▶ points at the side that's behind</Text>
      </View>
      {column("android")}
    </View>
  );
}

// ─── C · Drift inbox: only what's out of parity, as fix-it cards. Everything green folds away.

function DriftInbox({ report, summary, styles, theme }: VariantProps) {
  const [showGreen, setShowGreen] = useState(false);
  const groups = byDimension(report);
  const exceptions = report.checks.filter((check) => check.exception);
  return (
    <>
      <View style={styles.scoreboard}>
        {groups.map((group) => {
          const ok = group.green === group.total;
          return (
            <View key={group.key} style={[styles.scoreChip, { borderColor: ok ? theme.colors.statusSuccess : theme.colors.statusDanger }]}>
              <Text style={styles.scoreLabel}>{group.label}</Text>
              <Text style={[styles.scoreValue, { color: ok ? theme.colors.statusSuccess : theme.colors.statusDanger }]}>
                {group.green}/{group.total}
              </Text>
            </View>
          );
        })}
      </View>
      <Text style={styles.sectionLabel}>
        {summary.drift.length} TO FIX · iOS behind on {summary.failing.ios} · Android behind on {summary.failing.android}
      </Text>
      {summary.drift.map((check) => (
        <DriftCard key={check.id} check={check} styles={styles} theme={theme} />
      ))}
      <Text style={styles.sectionLabel}>INTENTIONAL DIFFERENCES</Text>
      {exceptions.map((check) => {
        const entry = report.exceptions.find((item) => item.id === check.exception);
        return (
          <View key={check.id} style={styles.exceptionCard}>
            <Text style={styles.text}>{check.title}</Text>
            <Text style={styles.muted}>
              {entry?.reason} · {entry?.approvedBy}
            </Text>
            <Text style={styles.mono}>
              iOS {check.ios.value ?? check.ios.note} · Android {check.android.value ?? check.android.note}
            </Text>
          </View>
        );
      })}
      <Pressable accessibilityRole="button" onPress={() => setShowGreen((value) => !value)} style={styles.button}>
        <Text style={styles.buttonText}>
          {showGreen ? "Hide" : "Show"} {summary.green - exceptions.length} matching checks
        </Text>
      </Pressable>
      {showGreen
        ? report.checks
            .filter((check) => inParity(check) && !check.exception)
            .map((check) => (
              <Text key={check.id} style={styles.muted}>
                ✓ {check.title}
              </Text>
            ))
        : null}
    </>
  );
}

function DriftCard({ check, styles, theme }: { check: Check; styles: Styles; theme: Theme }) {
  const lagging = behind(check);
  return (
    <View style={styles.driftCard}>
      <View style={styles.driftHead}>
        <Text style={styles.driftDim}>{check.dimension}</Text>
        <Text style={styles.text}>{check.title}</Text>
        <View style={styles.flex} />
        {lagging.map((platform) => (
          <Text key={platform} style={styles.behindPill}>
            {platform === "ios" ? "iOS" : "Android"} behind
          </Text>
        ))}
      </View>
      {PLATFORMS.map((platform) => (
        <View key={platform} style={styles.driftSide}>
          <Text style={styles.driftPlatform}>{platform === "ios" ? "iOS" : "Android"}</Text>
          <SideCell side={check[platform]} styles={styles} theme={theme} />
        </View>
      ))}
      <View style={styles.actions}>
        {/* Stub: the real one would start a fix round scoped to this check on the lagging platform. */}
        <Pressable accessibilityRole="button" style={styles.button}>
          <Text style={styles.buttonText}>Send to fix round</Text>
        </Pressable>
        <Pressable accessibilityRole="button" style={styles.button}>
          <Text style={styles.buttonText}>Mark intentional…</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ─── Shared bits

function SideCell({ side, styles, theme }: { side: Side; styles: Styles; theme: Theme }) {
  const color =
    side.status === "pass" ? theme.colors.statusSuccess : side.status === "fail" ? theme.colors.statusDanger : theme.colors.foregroundMuted;
  const mark = side.status === "pass" ? "✓" : side.status === "fail" ? "✕" : "–";
  return (
    <View>
      <Text style={[styles.text, { color }]}>
        {mark} {side.value ?? ""}
      </Text>
      {side.note ? <Text style={styles.note}>{side.note}</Text> : null}
    </View>
  );
}

function CoreLine({ report, summary, styles, theme }: VariantProps) {
  return (
    <Text style={[styles.muted, !summary.coreMatch ? { color: theme.colors.statusDanger } : null]}>
      Shared core: iOS {report.sharedCore.ios} · Android {report.sharedCore.android}
      {summary.coreMatch ? " · same state on both" : " · MISMATCH"}
    </Text>
  );
}

function Screenshots({ report, styles, theme }: { report: ParityReport; styles: Styles; theme: Theme }) {
  const { screenshots } = report;
  const frame = (label: string, caption: string, color?: string) => (
    <View style={styles.shotCol}>
      <View style={styles.phone}>
        <Text style={styles.phoneLabel}>{label}</Text>
      </View>
      <Text style={[styles.muted, color ? { color } : null]}>{caption}</Text>
    </View>
  );
  const diff = (platform: Platform) => {
    const value = screenshots.diff[platform];
    const over = value > screenshots.budget;
    return frame(screenshots[platform], `Δ ${value}% ${over ? "⚠ over" : "within"} ${screenshots.budget}%`, over ? theme.colors.statusWarning : undefined);
  };
  return (
    <View style={styles.shots}>
      {frame(screenshots.baseline, "baseline")}
      {diff("ios")}
      {diff("android")}
    </View>
  );
}

function Files({ report, styles }: { report: ParityReport; styles: Styles }) {
  return (
    <View style={styles.files}>
      <Text style={styles.sectionLabel}>CODE · ONE FILE PER SIDE</Text>
      {report.files.map((file) => (
        <View key={file.area} style={styles.fileRow}>
          <Text style={[styles.muted, styles.fileArea]}>{file.area}</Text>
          <Text style={[styles.mono, styles.flex]}>
            {file.ios} +{file.iosLines}
          </Text>
          <Text style={styles.muted}>↔</Text>
          <Text style={[styles.mono, styles.flex]}>
            {file.android} +{file.androidLines}
          </Text>
        </View>
      ))}
    </View>
  );
}

function createStyles(theme: Theme) {
  const c = theme.colors;
  return {
    overlay: {
      zIndex: 30,
      position: "absolute" as const,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: "rgba(0, 0, 0, 0.45)",
      padding: 16,
    },
    sheet: { flex: 1, backgroundColor: c.surface0, borderRadius: 14, borderWidth: 1, borderColor: c.border, overflow: "hidden" as const },
    head: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 10,
      paddingHorizontal: 18,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    proto: { color: c.statusWarning, fontSize: 10, fontWeight: "700" as const, letterSpacing: 1 },
    storyId: { color: c.foregroundMuted, fontSize: 12, fontWeight: "600" as const },
    title: { color: c.foreground, fontSize: 15, fontWeight: "600" as const, flexShrink: 1 },
    gate: { fontSize: 12, fontWeight: "600" as const },
    flex: { flex: 1 },
    body: { padding: 18, gap: 14, paddingBottom: 80 },
    text: { color: c.foreground, fontSize: 13 },
    muted: { color: c.foregroundMuted, fontSize: 12 },
    note: { color: c.foregroundMuted, fontSize: 11.5, marginTop: 2 },
    mono: { color: c.foreground, fontSize: 12, fontFamily: "Menlo" },
    sectionLabel: { color: c.foregroundMuted, fontSize: 11, fontWeight: "600" as const, letterSpacing: 0.5, marginTop: 4 },
    exception: { color: c.accent, fontSize: 11, marginTop: 2 },
    button: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: c.border, alignSelf: "flex-start" as const },
    buttonText: { color: c.foreground, fontSize: 12 },
    actions: { flexDirection: "row" as const, gap: 8 },

    table: { borderWidth: 1, borderColor: c.border, borderRadius: 10, overflow: "hidden" as const },
    row: { flexDirection: "row" as const, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: c.border, gap: 12 },
    rowHead: { borderTopWidth: 0, backgroundColor: c.surface1 },
    rowDrift: { backgroundColor: c.surface1 },
    colHead: { color: c.foregroundMuted, fontSize: 11, fontWeight: "600" as const },
    cellName: { flex: 2 },
    cellSide: { flex: 3 },
    groupRow: {
      flexDirection: "row" as const,
      alignItems: "baseline" as const,
      gap: 8,
      paddingHorizontal: 12,
      paddingTop: 12,
      paddingBottom: 4,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    groupLabel: { color: c.foreground, fontSize: 11, fontWeight: "700" as const, letterSpacing: 0.5 },
    groupHint: { color: c.foregroundMuted, fontSize: 11 },
    groupScore: { fontSize: 12, fontWeight: "600" as const },

    shots: { flexDirection: "row" as const, gap: 16 },
    shotCol: { alignItems: "center" as const, gap: 6 },
    phone: {
      width: 120,
      height: 220,
      borderRadius: 18,
      borderWidth: 2,
      borderColor: c.border,
      backgroundColor: c.surface1,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      gap: 6,
      padding: 8,
    },
    phoneLabel: { color: c.foregroundMuted, fontSize: 11, textAlign: "center" as const },
    files: { gap: 6 },
    fileRow: { flexDirection: "row" as const, gap: 10, alignItems: "center" as const },
    fileArea: { width: 60 },

    mirror: { flexDirection: "row" as const, gap: 16, alignItems: "flex-start" as const },
    mirrorCol: { flex: 1, gap: 8, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: c.border },
    mirrorHead: { color: c.foreground, fontSize: 14, fontWeight: "700" as const },
    failItem: { borderLeftWidth: 3, borderLeftColor: c.statusDanger, paddingLeft: 8, gap: 2 },
    failNote: { color: c.statusDanger, fontSize: 11.5 },
    spine: { width: 170, alignItems: "stretch" as const, gap: 6, paddingTop: 8 },
    spineScore: { color: c.foreground, fontSize: 20, fontWeight: "700" as const, textAlign: "center" as const, marginBottom: 6 },
    spineChip: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      paddingVertical: 5,
      paddingHorizontal: 8,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: c.statusSuccess,
    },
    spineDrift: { borderColor: c.statusDanger, backgroundColor: c.surface1 },
    spineLabel: { flex: 1, color: c.foreground, fontSize: 12, textAlign: "center" as const },
    spineArrow: { width: 14, color: c.statusDanger, fontSize: 11, textAlign: "center" as const },
    spineHint: { color: c.foregroundMuted, fontSize: 10.5, textAlign: "center" as const, marginTop: 6 },

    scoreboard: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
    scoreChip: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, gap: 2, minWidth: 92 },
    scoreLabel: { color: c.foregroundMuted, fontSize: 11 },
    scoreValue: { fontSize: 15, fontWeight: "700" as const },
    driftCard: { gap: 8, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: c.statusDanger, backgroundColor: c.surface1 },
    driftHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    driftDim: {
      color: c.foregroundMuted,
      fontSize: 10.5,
      textTransform: "uppercase" as const,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    behindPill: { color: c.statusDanger, fontSize: 11, fontWeight: "600" as const },
    driftSide: { flexDirection: "row" as const, gap: 10 },
    driftPlatform: { width: 60, color: c.foregroundMuted, fontSize: 12 },
    exceptionCard: { gap: 3, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: c.border, borderStyle: "dashed" as const },

    switcher: {
      position: "absolute" as const,
      bottom: 28,
      alignSelf: "center" as const,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 999,
      backgroundColor: "#111",
      shadowColor: "#000",
      shadowOpacity: 0.35,
      shadowRadius: 10,
    },
    switchArrow: { paddingHorizontal: 6 },
    switchText: { color: "#fff", fontSize: 13, fontWeight: "600" as const },
  };
}
