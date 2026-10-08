import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { openExternalUrl, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  getProdPulse,
  getProdPulseAutomation,
  type ProdPulse,
  type ProdPulseAutomation,
  type ProdPulseCard,
  type ProdPulseIssue,
} from "../shared/orchestration";
import { prodPulseSettings } from "../shared/settings";
import { Skeleton, SkeletonBar } from "./skeleton";

const PULSE_POLL_MS = 5 * 60 * 1000;

type Theme = PluginSurfaceProps["theme"];
type Styles = ReturnType<typeof createStyles>;
type Tone = "danger" | "warning" | "success" | "accent" | "muted";
type SectionId = "health" | "newBugs" | "older" | "nextSteps";

const DEFAULT_SECTIONS: Record<SectionId, boolean> = {
  health: true,
  newBugs: true,
  older: false,
  nextSteps: true,
};

export function useProdPulse() {
  const load = useRpc(getProdPulse);
  const [pulse, setPulse] = useState<ProdPulse | null>(null);
  // True once the first fetch settles, either way; later refreshes keep content on screen.
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setPulse(await load({}));
    } catch {
      setPulse(null);
    } finally {
      setLoaded(true);
    }
  }, [load]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, PULSE_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [refresh]);

  return { pulse, loaded, refresh };
}

// The Pulse tab body. Scrolls with the tab, so it has no ScrollView of its own.
export function ProdPulsePanel({
  pulse,
  theme,
  compact,
  onRefresh,
}: {
  pulse: ProdPulse;
  theme: Theme;
  compact: boolean;
  onRefresh(): Promise<void>;
}) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [sections, setSections] = useState<Record<SectionId, boolean>>(DEFAULT_SECTIONS);

  useEffect(() => {
    void onRefresh();
  }, [onRefresh]);

  const outcome = outcomeBadge(pulse.outcome);
  const newBugs = pulse.issues.filter((issue) => issue.origin !== "seen-before");
  const seenBefore = pulse.issues.filter((issue) => issue.origin === "seen-before");

  function toggleSection(id: SectionId) {
    setSections((current) => ({ ...current, [id]: !current[id] }));
  }

  function toggle(id: string) {
    setExpanded((current) => ({ ...current, [id]: !current[id] }));
  }

  async function refresh() {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <Icon name="Activity" size={18} color={theme.colors.foreground} />
        <Text style={styles.title}>Prod pulse</Text>
        <Pill label={outcome.label} tone={outcome.tone} theme={theme} styles={styles} />
        <View style={styles.headerActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reload prod pulse"
            disabled={refreshing}
            onPress={() => {
              void refresh();
            }}
            style={styles.headerButton}
          >
            <Text style={styles.headerButtonText}>{refreshing ? "Loading…" : "Reload"}</Text>
          </Pressable>
        </View>
      </View>
      <Text style={styles.meta}>
        {pulse.checkedAt ? `Checked ${formatTime(pulse.checkedAt)} (${ago(pulse.checkedAt)})` : "Not checked yet"}
        {pulse.changedAt && pulse.changedAt !== pulse.checkedAt
          ? ` · Last change ${formatTime(pulse.changedAt)}`
          : ""}
      </Text>

      <View style={styles.bodyContent}>
        {pulse.outcome === "failed" ? (
          <Text style={styles.banner}>
            The last check failed: {pulse.failReason ?? "unknown error"}. Numbers below are from{" "}
            {pulse.changedAt ? formatTime(pulse.changedAt) : "the previous run"}.
          </Text>
        ) : pulse.stale ? (
          <Text style={styles.banner}>
            This may be out of date. No check has run since{" "}
            {pulse.checkedAt ? formatTime(pulse.checkedAt) : "the last publish"}. The scheduled
            job may have stopped.
          </Text>
        ) : null}
        <AutomationPanel theme={theme} styles={styles} />

        {pulse.systemNotes.map((note) => (
          <Text key={note} style={styles.muted}>
            {note}
          </Text>
        ))}

        <SectionHeader
          label={`RELEASE HEALTH · ${pulse.cards.length}`}
          open={sections.health}
          styles={styles}
          onToggle={() => toggleSection("health")}
        />
        {!sections.health ? null : pulse.cards.length === 0 ? (
          <Text style={styles.empty}>No releases recorded yet.</Text>
        ) : (
          pulse.cards.map((card) => (
            <HealthRow key={card.key} card={card} theme={theme} styles={styles} />
          ))
        )}

        <SectionHeader
          label={`NEW BUGS ON THIS RELEASE · ${newBugs.length}`}
          open={sections.newBugs}
          styles={styles}
          onToggle={() => toggleSection("newBugs")}
        />
        {!sections.newBugs ? null : newBugs.length === 0 ? (
          <Text style={styles.empty}>None. No new bugs in the current prod releases.</Text>
        ) : (
          <View style={styles.list}>
            {newBugs.map((issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                open={Boolean(expanded[issue.id])}
                theme={theme}
                styles={styles}
                onToggle={() => toggle(issue.id)}
              />
            ))}
          </View>
        )}

        {seenBefore.length > 0 || pulse.older.length > 0 ? (
          <>
            <SectionHeader
              label={`OLDER BUGS STILL HITTING · ${seenBefore.length + pulse.older.length}`}
              open={sections.older}
              styles={styles}
              onToggle={() => toggleSection("older")}
            />
            {sections.older ? (
              <View style={styles.list}>
                {seenBefore.map((issue) => (
                  <IssueRow
                    key={issue.id}
                    issue={issue}
                    open={Boolean(expanded[issue.id])}
                    theme={theme}
                    styles={styles}
                    onToggle={() => toggle(issue.id)}
                  />
                ))}
                {pulse.older.map((row) => (
                  <Pressable
                    key={row.id}
                    accessibilityRole="link"
                    accessibilityLabel={`Open ${row.title} in Sentry`}
                    disabled={!row.sentryUrl}
                    onPress={() => {
                      if (row.sentryUrl) {
                        void openExternalUrl(row.sentryUrl);
                      }
                    }}
                    style={styles.row}
                  >
                    <View style={styles.rowHead}>
                      <Pill label="Older" tone="muted" theme={theme} styles={styles} />
                      <Text style={styles.chip}>{row.product}</Text>
                      <Text style={styles.counts}>
                        {row.users.toLocaleString()} users · {row.events.toLocaleString()} events
                      </Text>
                    </View>
                    <Text style={styles.olderTitle} numberOfLines={2}>
                      {row.title}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </>
        ) : null}

        <SectionHeader
          label={`SUGGESTED NEXT STEPS · ${pulse.actions.length}`}
          open={sections.nextSteps}
          styles={styles}
          onToggle={() => toggleSection("nextSteps")}
        />
        {!sections.nextSteps ? null : pulse.actions.length === 0 ? (
          <Text style={styles.empty}>None.</Text>
        ) : (
          pulse.actions.map((action) => (
            <Text key={action} style={styles.bullet}>
              • {action}
            </Text>
          ))
        )}

        {pulse.dashboardUrl ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Open the full release health dashboard"
            onPress={() => {
              if (pulse.dashboardUrl) {
                void openExternalUrl(pulse.dashboardUrl);
              }
            }}
            style={styles.linkButton}
          >
            <Text style={styles.linkButtonText}>Open full release health dashboard</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

// Pulse tab first load: header, meta line and three section rows (children of LoadingState).
export function ProdPulseSkeleton({ theme, compact }: { theme: Theme; compact: boolean }) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  return (
    <Skeleton>
      <View style={styles.panel}>
        <SkeletonBar theme={theme} width="40%" height={22} />
        <SkeletonBar theme={theme} width="55%" height={12} />
        <View style={styles.bodyContent}>
          <SkeletonBar theme={theme} height={16} />
          <SkeletonBar theme={theme} height={16} />
          <SkeletonBar theme={theme} height={16} />
        </View>
      </View>
    </Skeleton>
  );
}

function AutomationPanel({ theme, styles }: { theme: Theme; styles: Styles }) {
  const settings = useSettings(prodPulseSettings);
  const loadAutomation = useRpc(getProdPulseAutomation);
  const [automation, setAutomation] = useState<ProdPulseAutomation | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = settings.status === "ready" && settings.values.autoSchedule;

  const refresh = useCallback(async () => {
    try {
      setAutomation(await loadAutomation({}));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to read schedules.");
    }
  }, [loadAutomation]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggle() {
    if (settings.status !== "ready" || saving) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await settings.save({ ...settings.values, autoSchedule: !enabled }, settings.revision);
      if (!saved) {
        throw new Error(settings.saveError ?? "Could not save the automation setting.");
      }
      // The daemon applies the change from its settings subscription; give it a moment first.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the automation setting.");
    } finally {
      setSaving(false);
    }
  }

  const installed = automation?.jobInstalled ?? true;
  const active = automation?.schedules.filter((schedule) => schedule.status === "active").length ?? 0;
  const disabled = settings.status !== "ready" || saving || (!enabled && !installed);
  return (
    <View style={styles.automation}>
      <View style={styles.automationHead}>
        <View style={styles.automationText}>
          <Text style={styles.blockLabel}>AUTOMATION</Text>
          <Text style={styles.automationTitle}>Run prod pulse on a schedule</Text>
        </View>
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: enabled, disabled }}
          accessibilityLabel="Run prod pulse on a schedule"
          disabled={disabled}
          onPress={() => {
            void toggle();
          }}
          style={[
            styles.switchTrack,
            { backgroundColor: enabled ? theme.colors.accent : theme.colors.surface2 },
            disabled ? styles.switchDisabled : null,
          ]}
        >
          <View style={[styles.switchThumb, enabled ? styles.switchThumbOn : null]} />
        </Pressable>
        <Text style={styles.switchLabel}>{saving ? "Saving…" : enabled ? "On" : "Off"}</Text>
      </View>
      <Text style={styles.muted}>
        Mondays and Fridays 13:00 (Central). Each run starts a small Haiku agent; runs that find
        changes also call Claude and publish the dashboard. Off pauses the schedule, nothing is
        deleted.
      </Text>
      {!installed ? (
        <Text style={styles.caveat}>Pulse job not found at {automation?.jobPath}. Install it to turn this on.</Text>
      ) : null}
      {automation?.schedules.map((schedule) => (
        <View key={schedule.name} style={styles.rowHead}>
          <Pill
            label={schedule.status === "missing" ? "Not created" : schedule.status === "active" ? "Active" : "Paused"}
            tone={schedule.status === "active" ? "success" : "muted"}
            theme={theme}
            styles={styles}
          />
          <Text style={styles.bullet}>{schedule.label}</Text>
          {schedule.status === "active" && schedule.nextRunAt ? (
            <Text style={styles.counts}>next {formatTime(schedule.nextRunAt)}</Text>
          ) : null}
        </View>
      ))}
      {!enabled && active > 0 ? (
        <Text style={styles.caveat}>
          Off, but {active === 1 ? "1 schedule is" : `${active} schedules are`} still active from outside
          this tab. Turn this on and off again to pause {active === 1 ? "it" : "them"}.
        </Text>
      ) : null}
      {error || automation?.error ? <Text style={styles.caveat}>{error ?? automation?.error}</Text> : null}
    </View>
  );
}

function SectionHeader({
  label,
  open,
  styles,
  onToggle,
}: {
  label: string;
  open: boolean;
  styles: Styles;
  onToggle(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={`${open ? "Collapse" : "Expand"} ${label}`}
      onPress={onToggle}
      style={styles.sectionToggle}
    >
      <Text style={styles.sectionLabel}>
        {open ? "▾" : "▸"} {label}
      </Text>
    </Pressable>
  );
}

function HealthRow({ card, theme, styles }: { card: ProdPulseCard; theme: Theme; styles: Styles }) {
  return (
    <Pressable
      accessibilityRole={card.url ? "link" : undefined}
      accessibilityLabel={`${card.label} ${card.version}, ${card.healthLabel}. ${card.healthWhy}`}
      disabled={!card.url}
      onPress={() => {
        if (card.url) {
          void openExternalUrl(card.url);
        }
      }}
      style={styles.healthRow}
    >
      <View style={styles.rowHead}>
        <Text style={styles.healthName}>{card.label}</Text>
        <Text style={styles.mono}>{card.version}</Text>
        <Pill label={card.healthLabel} tone={healthTone(card.healthKey)} theme={theme} styles={styles} />
      </View>
      <View style={styles.healthStats}>
        <Stat value={formatRate(card.crashFreeSessions)} label="crash-free sessions" styles={styles} />
        <Stat value={formatRate(card.crashFreeUsers)} label="crash-free users" styles={styles} />
        <Stat value={formatCount(card.sessions)} label="sessions" styles={styles} />
        <Stat value={String(card.newBugs)} label="new bugs" styles={styles} />
      </View>
      <Text style={styles.muted}>{card.healthWhy}</Text>
      {card.caveat ? <Text style={styles.caveat}>{card.caveat}</Text> : null}
    </Pressable>
  );
}

function IssueRow({
  issue,
  open,
  theme,
  styles,
  onToggle,
}: {
  issue: ProdPulseIssue;
  open: boolean;
  theme: Theme;
  styles: Styles;
  onToggle(): void;
}) {
  const origin = originBadge(issue.origin);
  return (
    <View
      style={[styles.row, styles.issueRow, { borderLeftColor: signalColor(theme, origin.tone) ?? "transparent" }]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${origin.label} on ${issue.product}: ${issue.hit}. ${open ? "Collapse" : "Expand"}`}
        onPress={onToggle}
        style={styles.issueSummary}
      >
        <View style={styles.rowHead}>
          <Pill label={origin.label} tone={origin.tone} theme={theme} styles={styles} />
          <Text style={styles.chip}>{issue.product}</Text>
          {issue.trend === "rising" ? (
            <Pill label="Rising" tone="warning" theme={theme} styles={styles} />
          ) : issue.trend === "new" ? (
            <Pill label="Just in" tone="muted" theme={theme} styles={styles} />
          ) : null}
          {issue.groupedCount > 1 ? (
            <Text style={styles.chip}>{issue.groupedCount} issues</Text>
          ) : null}
          <Text style={styles.chevron}>{open ? "▾" : "▸"}</Text>
        </View>
        <Text style={issue.top ? styles.hitTop : styles.hit}>{issue.hit}</Text>
        <Text style={styles.counts}>
          {issue.users} · {issue.events}
        </Text>
      </Pressable>
      {open ? (
        <View style={styles.issueBody}>
          {issue.rawTitle ? <Text style={styles.raw}>{issue.rawTitle}</Text> : null}
          {issue.top ? (
            <View style={styles.block}>
              <Text style={styles.blockLabel}>REPRO</Text>
              {issue.repro.length > 0 ? (
                issue.repro.map((step, index) => (
                  <Text key={`${index}-${step}`} style={styles.bullet}>
                    {index + 1}. {step}
                  </Text>
                ))
              ) : (
                <Text style={styles.muted}>
                  {issue.reproMissing ?? "Not enough in the event to write repro steps."}
                </Text>
              )}
            </View>
          ) : null}
          {issue.likely ? (
            <View style={styles.likely}>
              <Text style={styles.likelyLabel}>LIKELY</Text>
              <Text style={styles.likelyText}>{issue.likely}</Text>
            </View>
          ) : null}
          {issue.findings.length > 0 ? (
            <View style={styles.block}>
              <Text style={styles.blockLabel}>INITIAL FINDINGS</Text>
              {issue.findings.map((line) => (
                <Text key={line} style={styles.bullet}>
                  • {line}
                </Text>
              ))}
            </View>
          ) : null}
          <View style={styles.actions}>
            {issue.watchUrl ? (
              <LinkButton label={`▶ ${issue.watchLabel}`} url={issue.watchUrl} styles={styles} />
            ) : (
              <Text style={styles.offButton}>{issue.watchLabel}</Text>
            )}
            {issue.sentryUrl ? (
              <LinkButton
                label={`Open ${issue.shortId ?? "issue"} in Sentry`}
                url={issue.sentryUrl}
                styles={styles}
              />
            ) : null}
          </View>
          <Text style={styles.foot}>
            {issue.firstSeen ? `First seen ${formatTime(issue.firstSeen)}` : ""}
            {issue.release ? `  ·  ${issue.release}` : ""}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function LinkButton({ label, url, styles }: { label: string; url: string; styles: Styles }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={() => {
        void openExternalUrl(url);
      }}
      style={styles.smallButton}
    >
      <Text style={styles.smallButtonText}>{label}</Text>
    </Pressable>
  );
}

function Stat({ value, label, styles }: { value: string; label: string; styles: Styles }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// Labels stay neutral; only a small dot carries color, and only when it needs attention.
function Pill({ label, tone, theme, styles }: { label: string; tone: Tone; theme: Theme; styles: Styles }) {
  const color = signalColor(theme, tone);
  return (
    <View style={styles.pill}>
      {color ? <View style={[styles.pillDot, { backgroundColor: color }]} /> : null}
      <Text style={styles.pillText}>{label}</Text>
    </View>
  );
}

function healthTone(key: ProdPulseCard["healthKey"]): Tone {
  return key === "unhealthy" ? "danger" : key === "watch" ? "warning" : key === "healthy" ? "success" : "muted";
}

function originBadge(origin: ProdPulseIssue["origin"]): { label: string; tone: Tone } {
  if (origin === "regression") {
    return { label: "Regression", tone: "danger" };
  }
  if (origin === "new") {
    return { label: "New", tone: "accent" };
  }
  if (origin === "seen-before") {
    return { label: "Seen before", tone: "muted" };
  }
  return { label: "Not checked", tone: "muted" };
}

function outcomeBadge(outcome: ProdPulse["outcome"]): { label: string; tone: Tone } {
  if (outcome === "failed") {
    return { label: "Last check failed", tone: "danger" };
  }
  if (outcome === "changed") {
    return { label: "Changes found", tone: "accent" };
  }
  if (outcome === "health") {
    return { label: "Health moved", tone: "warning" };
  }
  if (outcome === "none") {
    return { label: "No runs yet", tone: "muted" };
  }
  return { label: "No change", tone: "success" };
}

// Color is reserved for problems: red for regressions, unhealthy releases and failed runs,
// amber for watch and rising. Everything else is neutral so the problems stand out.
function signalColor(theme: Theme, tone: Tone) {
  return tone === "danger" ? theme.colors.statusDanger : tone === "warning" ? theme.colors.statusWarning : null;
}

function formatRate(value: number | null) {
  return value === null ? "–" : `${(value * 100).toFixed(2)}%`;
}

function formatCount(value: number | null) {
  return value === null ? "–" : value.toLocaleString();
}

function formatTime(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function ago(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!(ms >= 0)) {
    return "";
  }
  const hours = Math.round(ms / 36e5);
  return hours < 1 ? "under an hour ago" : hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function createStyles(theme: Theme, compact: boolean) {
  return {
    panel: {
      gap: 6,
    },
    header: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      flexWrap: "wrap" as const,
      gap: 10,
    },
    title: {
      color: theme.colors.foreground,
      fontSize: 18,
      fontWeight: "600" as const,
    },
    headerActions: {
      flexDirection: "row" as const,
      gap: 8,
      marginLeft: "auto" as const,
    },
    headerButton: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    headerButtonText: {
      color: theme.colors.foregroundMuted,
      fontSize: 13,
    },
    meta: {
      color: theme.colors.foregroundMuted,
      fontSize: 13,
    },
    bodyContent: {
      paddingVertical: compact ? 16 : 20,
      gap: 10,
    },
    banner: {
      color: theme.colors.foreground,
      borderWidth: 1,
      borderColor: theme.colors.statusDanger,
      borderRadius: 8,
      padding: 10,
      fontSize: 13,
    },
    automation: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 10,
      backgroundColor: theme.colors.surface1,
      padding: 12,
      gap: 8,
    },
    automationHead: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 10,
    },
    automationText: {
      flex: 1,
      gap: 2,
    },
    automationTitle: {
      color: theme.colors.foreground,
      fontSize: 15,
      fontWeight: "600" as const,
    },
    switchTrack: {
      width: 42,
      height: 24,
      borderRadius: 12,
      padding: 3,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    switchDisabled: {
      opacity: 0.5,
    },
    switchThumb: {
      width: 16,
      height: 16,
      borderRadius: 8,
      backgroundColor: theme.colors.foreground,
    },
    switchThumbOn: {
      marginLeft: 18,
      backgroundColor: theme.colors.accentForeground,
    },
    switchLabel: {
      color: theme.colors.foreground,
      fontWeight: "600" as const,
      minWidth: 52,
    },
    sectionLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
      fontWeight: "600" as const,
      letterSpacing: 0.8,
      marginTop: 8,
    },
    sectionToggle: {
      alignSelf: "stretch" as const,
      paddingVertical: 4,
    },
    empty: {
      color: theme.colors.foregroundMuted,
      borderWidth: 1,
      borderStyle: "dashed" as const,
      borderColor: theme.colors.border,
      borderRadius: 8,
      padding: 12,
    },
    list: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 10,
      overflow: "hidden" as const,
      backgroundColor: theme.colors.surface1,
    },
    healthRow: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 10,
      backgroundColor: theme.colors.surface1,
      padding: 12,
      gap: 8,
    },
    healthName: {
      color: theme.colors.foreground,
      fontWeight: "600" as const,
    },
    healthStats: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: 12,
    },
    stat: {
      minWidth: 96,
      flexGrow: 1,
      gap: 1,
    },
    statValue: {
      color: theme.colors.foreground,
      fontFamily: "monospace",
      fontSize: 14,
    },
    statLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
    },
    caveat: {
      color: theme.colors.foregroundMuted,
      fontStyle: "italic" as const,
      fontSize: 12,
    },
    row: {
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
      gap: 4,
    },
    issueRow: {
      borderLeftWidth: 3,
      paddingHorizontal: 0,
      paddingVertical: 0,
    },
    issueSummary: {
      paddingHorizontal: 12,
      paddingVertical: 10,
      gap: 4,
    },
    issueBody: {
      paddingHorizontal: 12,
      paddingBottom: 12,
      gap: 10,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
      paddingTop: 10,
      backgroundColor: theme.colors.surface2,
    },
    rowHead: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      alignItems: "center" as const,
      gap: 6,
    },
    chevron: {
      color: theme.colors.foregroundMuted,
      marginLeft: "auto" as const,
    },
    chip: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 4,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    pill: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 5,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 1,
    },
    pillDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
    },
    pillText: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
      fontWeight: "500" as const,
    },
    hit: {
      color: theme.colors.foreground,
      fontSize: 14,
    },
    hitTop: {
      color: theme.colors.foreground,
      fontSize: 14,
      fontWeight: "600" as const,
    },
    olderTitle: {
      color: theme.colors.foregroundMuted,
      fontSize: 13,
    },
    counts: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    raw: {
      color: theme.colors.foregroundMuted,
      fontFamily: "monospace",
      fontSize: 12,
    },
    mono: {
      color: theme.colors.foregroundMuted,
      fontFamily: "monospace",
      fontSize: 12,
    },
    block: {
      gap: 4,
    },
    blockLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      fontWeight: "600" as const,
      letterSpacing: 0.7,
    },
    bullet: {
      color: theme.colors.foreground,
      fontSize: 13,
    },
    likely: {
      flexDirection: "row" as const,
      gap: 8,
      borderRadius: 6,
      padding: 8,
      backgroundColor: theme.colors.surface1,
    },
    likelyLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      fontWeight: "600" as const,
    },
    likelyText: {
      color: theme.colors.foreground,
      fontSize: 13,
      flexShrink: 1,
    },
    actions: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: 8,
    },
    smallButton: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 5,
      backgroundColor: theme.colors.surface1,
    },
    smallButtonText: {
      color: theme.colors.foreground,
      fontSize: 13,
    },
    offButton: {
      color: theme.colors.foregroundMuted,
      fontSize: 13,
      borderWidth: 1,
      borderStyle: "dashed" as const,
      borderColor: theme.colors.border,
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    foot: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    muted: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    linkButton: {
      marginTop: 12,
      alignSelf: "flex-start" as const,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    linkButtonText: {
      color: theme.colors.foreground,
      fontWeight: "600" as const,
    },
  };
}
