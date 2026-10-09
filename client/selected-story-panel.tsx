import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { agentRunnerSettings } from "../shared/agent-runner";
import { contextAct, storyContextRpc, type StoryContext } from "../shared/context";
import { boardKey, gateAct } from "../shared/gates";
import { DEFAULT_LOOP_CONFIG, initiativeLoopSettings, startInitiativeLoop } from "../shared/initiative-loop";
import type { EpicBoardState, EpicStory } from "../shared/orchestration";
import { budgetSettings } from "../shared/settings";
import { stepBar, type Segment } from "../shared/story-steps";
import { useAgentProfiles } from "./runner-picker";
import { contextBlock, ctaAction, stepModels, type ContextBar } from "./selected-story-model";

// The selected story, inline under its initiative's graph on wide layouts (design lines 190–240):
// header with the step's CTA, the five-step row with each step's model, and the live session's
// context block with Compact / Hand off. A thin view over client/selected-story-model.ts.

type Theme = PluginSurfaceProps["theme"];
type Navigation = PluginSurfaceProps["navigation"];
type Styles = ReturnType<typeof createStyles>;

const CONTEXT_POLL_MS = 10_000;
const DEFAULT_CAP_USD = 5;

// The story's live context: read on select, every 10 s while mounted, and on `reload`. Null while
// the story has no live agent (or before the first read).
export function useStoryContext(repo: string, initiative: string, storyId: string) {
  const load = useRpc(storyContextRpc);
  const [ctx, setCtx] = useState<StoryContext | null>(null);
  // Only the newest read for the current story lands; a slow read for the last one is dropped.
  const reads = useRef(0);

  const reload = useCallback(async () => {
    const id = ++reads.current;
    try {
      const next = await load({ repo, initiative, storyId });
      if (id === reads.current) setCtx(next);
    } catch {
      // Keep the last reading; the next poll tries again.
    }
  }, [load, repo, initiative, storyId]);

  useEffect(() => {
    setCtx(null);
    void reload();
    const timer = setInterval(() => void reload(), CONTEXT_POLL_MS);
    return () => {
      clearInterval(timer);
      reads.current++;
    };
  }, [reload]);

  return { ctx, reload };
}

export function SelectedStoryPanel({
  repo,
  state,
  story,
  theme,
  compact,
  navigation,
  onDetails,
  onEditPolicy,
  onChanged,
}: {
  repo: string;
  state: EpicBoardState;
  story: EpicStory;
  theme: Theme;
  compact: boolean;
  navigation: Navigation;
  onDetails(): void;
  onEditPolicy?(): void;
  onChanged(): void;
}) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const toast = useToast();
  const act = useRpc(contextAct);
  const gate = useRpc(gateAct);
  const startLoop = useRpc(startInitiativeLoop);
  const loop = useSettings(initiativeLoopSettings);
  const runner = useSettings(agentRunnerSettings);
  const budget = useSettings(budgetSettings);
  const profiles = useAgentProfiles();
  const { ctx, reload } = useStoryContext(repo, state.initiativeSlug, story.id);
  const [busy, setBusy] = useState<"compact" | "fresh" | "start" | "retry" | null>(null);

  const bar = stepBar(story, "plan", state.stories);
  const models = stepModels(
    loop.status === "ready" ? loop.values : DEFAULT_LOOP_CONFIG,
    profiles,
    runner.status === "ready" ? runner.values.profileId : "",
  );
  const cta = ctaAction(bar.cta, story, state.repoUrl);
  const capUsd = budget.status === "ready" ? budget.values.storyCapUsd : DEFAULT_CAP_USD;
  const block = ctx ? contextBlock(ctx, ctx.costUsd, capUsd) : null;

  function runCta() {
    if (!cta) return;
    switch (cta.kind) {
      case "agent":
        navigation?.openAgent({ agentId: cta.agentId });
        return;
      case "pr":
        void openExternalUrl(cta.url);
        return;
      case "details":
        onDetails();
        return;
      case "start":
        void start();
        return;
    }
  }

  async function start() {
    if (busy !== null) return;
    setBusy("start");
    try {
      const result = await startLoop({ repo, initiative: state.initiativeSlug });
      if (!result.ok) toast.error(result.error ?? "Could not start the loop.");
      else toast.show(result.started.length ? `Loop started: planning ${result.started.map((item) => item.story).join(", ")}.` : `Loop on. ${result.reason}.`, { variant: "success" });
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not start the loop.");
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  // Retry a blocked story (see CONTEXT.md, "Gate action"), then re-read the boards.
  async function retry() {
    if (busy !== null) return;
    setBusy("retry");
    try {
      const board = boardKey({ repo, initiative: state.initiativeSlug });
      const result = await gate({ board, storyId: story.id, action: "retry" });
      if (!result.ok) toast.error(result.error ?? "Could not retry.");
      else toast.show(`Retrying ${story.id}.`, { variant: "success" });
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not retry.");
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  // Compact or Hand off the story's live session, then re-read its context and the boards (Hand
  // off moves the story's `agent:` to the new session).
  async function runAct(action: "compact" | "fresh") {
    if (!ctx || busy !== null) return;
    setBusy(action);
    try {
      const result = await act({ agentId: ctx.agentId, action });
      if (!result.ok) toast.error(result.error ?? (action === "compact" ? "Could not compact." : "Could not hand off."));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not change the session.");
    } finally {
      setBusy(null);
      void reload();
      onChanged();
    }
  }

  const segmentColor = (segment: Segment) =>
    segment === "done"
      ? theme.colors.statusSuccess
      : segment === "now"
        ? theme.colors.accent
        : segment === "gate"
          ? theme.colors.statusWarning
          : theme.colors.surface2;
  const barColor = (key: ContextBar["key"]) =>
    key === "system" ? theme.colors.foreground : key === "conversation" ? theme.colors.foregroundMuted : key === "tool" ? theme.colors.border : theme.colors.accent;
  const ctaLabel = busy === "start" ? "Starting…" : bar.cta;
  const acting = busy === "compact" || busy === "fresh";

  return (
    <View style={styles.box}>
      <View style={styles.head}>
        <Text style={styles.id}>{story.id}</Text>
        <Text style={[styles.title, styles.flex]} numberOfLines={1}>
          {story.title}
        </Text>
        <Text style={styles.muted} numberOfLines={1}>
          {bar.detail}
        </Text>
        {story.status === "blocked" ? (
          <SmallButton label={busy === "retry" ? "Retrying…" : "Retry"} disabled={busy !== null} styles={styles} onPress={() => void retry()} />
        ) : null}
        {cta ? <SmallButton label={ctaLabel} primary disabled={busy !== null} styles={styles} onPress={runCta} /> : null}
        <SmallButton label="Details" styles={styles} onPress={onDetails} />
      </View>

      <View style={styles.steps}>
        {bar.labels.map((label, i) => (
          <View key={label} style={styles.stepCol}>
            <View style={[styles.stepBar, { backgroundColor: segmentColor(bar.segments[i]) }]} />
            <Text style={[styles.stepLabel, bar.segments[i] === "todo" ? styles.muted : null]} numberOfLines={1}>
              {label}
            </Text>
            <Text style={styles.hint} numberOfLines={1}>
              {models[i]}
            </Text>
          </View>
        ))}
      </View>

      {ctx && block ? (
        <View style={styles.context}>
          <View style={styles.ctxHead}>
            <Text style={[styles.ctxTitle, styles.flex]}>{block.header}</Text>
            <Text style={styles.muted}>{block.usedLabel}</Text>
          </View>

          <View style={styles.meter}>
            <View style={styles.meterTrack}>
              {block.bars.map((item) => (
                <View key={item.key} style={{ width: `${item.width}%`, backgroundColor: barColor(item.key) }} />
              ))}
            </View>
            {block.warnAt !== null ? (
              <Tick at={block.warnAt} label={`warn ${block.warnAt}`} color={theme.colors.statusWarning} styles={styles} />
            ) : null}
            {block.actAt !== null ? (
              <Tick at={block.actAt} label={`${block.actWord} ${block.actAt}`} color={theme.colors.statusDanger} wide styles={styles} />
            ) : null}
          </View>

          <View style={styles.legend}>
            {block.legend.map((text, i) => {
              const key = block.bars[i]?.key;
              return (
                <View key={text} style={styles.legendItem}>
                  {key && text !== "approx." ? <View style={[styles.swatch, { backgroundColor: barColor(key) }]} /> : null}
                  <Text style={styles.hint}>{text}</Text>
                </View>
              );
            })}
            {block.compactionNote ? <Text style={styles.hint}>{block.compactionNote}</Text> : null}
          </View>

          <View style={styles.stats}>
            <View style={styles.stat}>
              <Text style={styles.hint}>Cost so far</Text>
              <Text style={styles.statValue}>{block.cost}</Text>
              <Text style={styles.hint}>{block.cap}</Text>
            </View>
            <View style={[styles.stat, styles.statDivider]}>
              <Text style={styles.hint}>Burn</Text>
              <Text style={styles.statValue}>{block.burn}</Text>
            </View>
            <View style={[styles.stat, styles.statDivider]}>
              <Text style={styles.hint}>{block.hitsLabel}</Text>
              <Text style={[styles.statValue, block.turnsTone === "amber" ? { color: theme.colors.statusWarning } : null]}>
                {block.turnsLeft}
              </Text>
            </View>
          </View>

          <View style={styles.acts}>
            <View style={styles.actCard}>
              <View style={styles.flex}>
                <Text style={styles.actTitle}>Compact now</Text>
                <Text style={styles.hint}>Same agent continues. History is summarized.</Text>
              </View>
              <SmallButton
                label={busy === "compact" ? "Compacting…" : "Compact"}
                primary
                disabled={acting}
                styles={styles}
                onPress={() => void runAct("compact")}
              />
            </View>
            <View style={styles.actCard}>
              <View style={styles.flex}>
                <Text style={styles.actTitle}>Fresh session + handoff</Text>
                <Text style={styles.hint}>Progress goes to .harness/state.md; new agent resumes.</Text>
              </View>
              <SmallButton
                label={busy === "fresh" ? "Handing off…" : "Hand off"}
                disabled={acting}
                styles={styles}
                onPress={() => void runAct("fresh")}
              />
            </View>
          </View>

          <View style={styles.policy}>
            <Text style={styles.hint}>{block.policy}</Text>
            {onEditPolicy ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Edit context policy" onPress={onEditPolicy}>
                <Text style={styles.link}>Edit</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function Tick({ at, label, color, wide, styles }: { at: number; label: string; color: string; wide?: boolean; styles: Styles }) {
  return (
    <>
      <View pointerEvents="none" style={[styles.tickLine, { left: `${at}%`, width: wide ? 2 : 1, backgroundColor: color }]} />
      <Text pointerEvents="none" style={[styles.tickLabel, { left: `${at}%`, color }]} numberOfLines={1}>
        {label}
      </Text>
    </>
  );
}

function SmallButton({
  label,
  primary,
  disabled,
  styles,
  onPress,
}: {
  label: string;
  primary?: boolean;
  disabled?: boolean;
  styles: Styles;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, primary ? styles.buttonPrimary : null, disabled ? styles.buttonDisabled : null]}
    >
      <Text style={[styles.buttonText, primary ? styles.buttonPrimaryText : null]}>{label}</Text>
    </Pressable>
  );
}

function createStyles(theme: Theme, compact: boolean) {
  const c = theme.colors;
  return {
    box: { gap: 12, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface0 },
    head: { flexDirection: "row" as const, alignItems: "center" as const, flexWrap: "wrap" as const, gap: 8 },
    id: { color: c.foregroundMuted, fontFamily: "monospace", fontSize: 11.5 },
    title: { color: c.foreground, fontSize: 12.5, minWidth: 0 },
    flex: { flex: 1 },
    muted: { color: c.foregroundMuted, fontSize: 12 },
    hint: { color: c.foregroundMuted, fontSize: 11.5 },
    steps: { flexDirection: "row" as const, gap: 6 },
    stepCol: { flex: 1, minWidth: 0, gap: 4 },
    stepBar: { height: 3, borderRadius: 2 },
    stepLabel: { color: c.foreground, fontSize: 11.5 },
    context: { gap: 12, paddingTop: 14, borderTopWidth: 1, borderTopColor: c.border },
    ctxHead: { flexDirection: "row" as const, alignItems: "baseline" as const, gap: 10 },
    ctxTitle: { color: c.foreground, fontSize: 13, fontWeight: "600" as const },
    meter: { position: "relative" as const, paddingTop: 14 },
    meterTrack: { flexDirection: "row" as const, height: 10, borderRadius: 5, overflow: "hidden" as const, backgroundColor: c.surface2 },
    tickLine: { position: "absolute" as const, top: 0, bottom: -4 },
    tickLabel: { position: "absolute" as const, top: 0, fontSize: 10, transform: [{ translateX: -20 }] },
    legend: { flexDirection: "row" as const, flexWrap: "wrap" as const, columnGap: 16, rowGap: 6 },
    legendItem: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    swatch: { width: 8, height: 8, borderRadius: 2 },
    stats: { flexDirection: "row" as const, flexWrap: "wrap" as const, borderWidth: 1, borderColor: c.border, borderRadius: 8, overflow: "hidden" as const },
    stat: { flexGrow: 1, flexBasis: 130, paddingVertical: 10, paddingHorizontal: 12, gap: 2 },
    statDivider: { borderLeftWidth: 1, borderLeftColor: c.border },
    statValue: { color: c.foreground, fontSize: 16, fontWeight: "600" as const },
    acts: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
    actCard: {
      flexGrow: 1,
      flexBasis: 260,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 10,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.border,
    },
    actTitle: { color: c.foreground, fontSize: 12.5, fontWeight: "600" as const },
    policy: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    link: { color: c.foreground, fontSize: 11.5, textDecorationLine: "underline" as const },
    button: {
      minHeight: compact ? 44 : 28,
      justifyContent: "center" as const,
      paddingHorizontal: 11,
      borderRadius: 7,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface1,
    },
    buttonPrimary: { backgroundColor: c.accent, borderColor: c.accent },
    buttonDisabled: { opacity: 0.6 },
    buttonText: { color: c.foreground, fontSize: 12 },
    buttonPrimaryText: { color: c.accentForeground, fontWeight: "600" as const },
  };
}
