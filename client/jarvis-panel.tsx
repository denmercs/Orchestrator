import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import type { EpicBoard } from "../shared/orchestration";
import type { createVoiceRunner } from "./voice-runner";
import { VoiceInterpretPanel } from "./voice-interpret-panel";
import { drawerMicView, hasMicApi, ignoreMeView, openChatView, PASEO_STOP_HINT, SETTINGS_UNREADABLE_NOTICE, voiceOffNotice, voiceStatusLine } from "./voice-mic-model";
import { ProfileChips, useAgentProfiles } from "./runner-picker";
import { PANEL_WIDTH, replyActions, storyChips, type PanelPlacement, type StoryChip } from "./jarvis-panel-model";
import { profileCaption, type AgentProfile } from "../shared/agent-profiles";
import { voiceSettings } from "../shared/settings";
import { voiceChipId, voiceModelLine, voiceProfileFor } from "../shared/voice-session";

type Theme = PluginSurfaceProps["theme"];
type VoiceRunner = ReturnType<typeof createVoiceRunner>;

const OFF_CHIP: AgentProfile = { id: "off", name: "Off", provider: "" };

const MODE_LABEL = {
  asleep: 'Asleep — say "Hey Jarvis"',
  listening: "Listening",
  confirming: "Waiting for your word",
  waiting: "Sent, waiting",
  speaking: "Speaking",
} as const;

function useRunner(runner: VoiceRunner) {
  return useSyncExternalStore(runner.subscribe, runner.getState, runner.getState);
}

export type JarvisPanelProps = {
  theme: Theme;
  compact: boolean;
  placement: PanelPlacement;
  runner: VoiceRunner;
  boards: EpicBoard[] | null;
  // The briefing, shown as the first message (never spoken).
  intro: string | null;
  // Text box contents and the note under it (set by Ask); the dashboard owns both so a story card can fill them.
  draft: string;
  note: string | null;
  onDraft(text: string): void;
  // Strip pressed: dock it (wide) or open it over the dashboard (narrow).
  onOpen(): void;
  // Docked: collapse to the strip. Overlay: close it.
  onClose(): void;
  onChip(chip: StoryChip): void;
  // Opens a Paseo agent's chat; absent when the host gives the plugin no navigation.
  navigation?: PluginSurfaceProps["navigation"];
};

// The Jarvis panel: a strip, the docked panel beside the dashboard, or the same panel lying over it.
export function JarvisPanel(props: JarvisPanelProps) {
  const { theme, compact, placement, runner, onOpen, onClose } = props;
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  if (placement === "strip") return <Strip styles={styles} runner={runner} onPress={onOpen} />;
  if (placement === "overlay") {
    return (
      <View style={styles.overlay}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close Jarvis" onPress={onClose} style={styles.backdrop} />
        <View style={[styles.panel, styles.panelOverlay]} accessibilityViewIsModal>
          <PanelBody {...props} styles={styles} />
        </View>
      </View>
    );
  }
  return (
    <View style={[styles.panel, styles.panelDocked]}>
      <PanelBody {...props} styles={styles} />
    </View>
  );
}

type Styles = ReturnType<typeof createStyles>;

function Strip({ styles, runner, onPress }: { styles: Styles; runner: VoiceRunner; onPress(): void }) {
  const state = useRunner(runner);
  const on = state.micOn;
  const listening = on && state.mode !== "asleep";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open Jarvis, mic ${on ? "on" : "off"}`}
      onPress={onPress}
      style={styles.strip}
    >
      <Text style={styles.stripText}>‹</Text>
      <View style={[styles.dot, on ? styles.dotOn : null, listening ? styles.dotListening : null]} />
      <Text style={styles.stripLabel}>Jarvis</Text>
    </Pressable>
  );
}

function PanelBody({ theme, compact, runner, navigation, boards, intro, draft, note, onDraft, onClose, onChip, placement, styles }: JarvisPanelProps & { styles: Styles }) {
  const state = useRunner(runner);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const scroll = useRef<{ scrollToEnd?(options?: { animated?: boolean }): void } | null>(null);
  const on = state.micOn;
  const awake = state.mode !== "asleep";
  const view = drawerMicView({ hasMicApi: hasMicApi(globalThis.navigator), error: state.error });
  const ignore = ignoreMeView(state.ignoring);
  const micApi = hasMicApi(globalThis.navigator);
  const voice = useSettings(voiceSettings);
  const profiles = useAgentProfiles();
  const profileSetting = voice.status === "ready" ? voice.values.profile : "";
  const offNotice = voiceOffNotice(profileSetting);
  const chat = openChatView(state.jarvisAgentId, !!navigation);
  const needsWhisper = view.error ? /whisper|ffmpeg|model/i.test(view.error) : false;
  const actions = replyActions(state);
  const chipsFor = (text: string) => storyChips(text, boards ?? [], state.sessions);

  const send = () => {
    if (!draft.trim()) return;
    runner.type(draft);
    onDraft("");
  };

  const chipRow = (text: string) => {
    const chips = chipsFor(text);
    if (chips.length === 0) return null;
    return (
      <View style={styles.chips}>
        {chips.map((chip) => (
          <Pressable
            key={`${chip.board}:${chip.id}`}
            accessibilityRole="button"
            accessibilityLabel={`${chip.id}, ${chip.title}`}
            onPress={() => onChip(chip)}
            style={styles.chip}
          >
            <Text style={styles.chipText}>{chip.id}</Text>
          </Pressable>
        ))}
      </View>
    );
  };

  return (
    <>
      <View style={styles.header}>
        <View style={[styles.dot, on ? styles.dotOn : null]} />
        <Text style={styles.title}>Jarvis</Text>
        <Text style={[styles.hint, styles.flex1]} numberOfLines={1}>
          {state.talking
            ? "Listening… tap to send"
            : state.ignoring
              ? "Ignoring you"
              : micApi
                ? state.micUnavailable
                  ? "Mic unavailable"
                  : MODE_LABEL[state.mode]
                : voiceStatusLine(state.voiceGuess)}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel={placement === "overlay" ? "Close Jarvis" : "Collapse Jarvis"} onPress={onClose}>
          <Text style={styles.headerButtonText}>{placement === "overlay" ? "×" : "›"}</Text>
        </Pressable>
      </View>

      {state.phoneActive ? <Text style={[styles.hint, styles.pad]}>Phone is speaking</Text> : null}
      {ignore.status ? <Text style={[styles.hint, styles.pad, styles.danger]}>{ignore.status}</Text> : null}
      {state.settingsUnreadable ? (
        <View style={[styles.row, styles.pad]}>
          <Text style={[styles.hint, styles.danger, styles.flex1]}>{SETTINGS_UNREADABLE_NOTICE}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Repair voice settings" onPress={() => void runner.repairSettings()} style={styles.action}>
            <Text style={styles.actionText}>Repair</Text>
          </Pressable>
        </View>
      ) : null}
      {micApi && state.micUnavailable && !state.ignoring ? <Text style={[styles.hint, styles.pad, styles.danger]}>Mic unavailable. Allow the microphone for Paseo.</Text> : null}

      <ScrollView
        ref={scroll as never}
        style={styles.flex1}
        contentContainerStyle={styles.body}
        onContentSizeChange={() => scroll.current?.scrollToEnd?.({ animated: false })}
      >
        {intro ? (
          <View style={styles.jarvisMessage}>
            <Text style={styles.sessionText}>{intro}</Text>
            {chipRow(intro)}
          </View>
        ) : null}
        {state.conversation.length === 0 && !intro ? <Text style={styles.hint}>Nothing yet. Type below, or tap to talk.</Text> : null}
        {state.conversation.map((entry, i) =>
          entry.from === "you" ? (
            <View key={`${i}-you-${entry.text}`} style={styles.youMessage}>
              <Text style={styles.sessionText}>{entry.text}</Text>
              {entry.outcome ? <Text style={styles.hint}>{entry.outcome}</Text> : null}
            </View>
          ) : (
            <View key={`${i}-jarvis-${entry.text}`} style={styles.jarvisMessage}>
              <Text style={styles.sessionText}>{entry.text}</Text>
              {chipRow(entry.text)}
            </View>
          ),
        )}

        {state.mode === "confirming" && state.confirm ? <Text style={styles.sessionText}>{state.confirm.text}</Text> : null}
        {actions.length > 0 ? (
          <View style={styles.chips}>
            {actions.map((action) => (
              <Pressable key={action.label} accessibilityRole="button" onPress={() => runner.dispatch(action.event)} style={styles.action}>
                <Text style={styles.actionText}>{action.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {view.error ? (
          <View style={styles.card}>
            <Text style={[styles.hint, styles.danger]}>{view.error}</Text>
            {needsWhisper ? (
              <Text style={styles.hint}>Voice needs ffmpeg, whisper-cli (whisper-cpp) and the small.en model installed on this machine.</Text>
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.composer}>
        {note ? <Text style={styles.hint}>{note}</Text> : null}
        <View style={styles.row}>
          <TextInput
            accessibilityLabel="Message Jarvis"
            value={draft}
            onChangeText={onDraft}
            onSubmitEditing={send}
            placeholder="Type to Jarvis"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCorrect={false}
            style={styles.input}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            disabled={!draft.trim()}
            onPress={send}
            style={[styles.action, !draft.trim() ? styles.disabled : null]}
          >
            <Text style={styles.actionText}>Send</Text>
          </Pressable>
        </View>
        <View style={styles.row}>
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: ignore.on }}
            accessibilityLabel={ignore.action}
            onPress={() => void runner.setMic(state.ignoring)}
            style={[styles.action, ignore.on ? styles.actionOn : null]}
          >
            <Text style={styles.actionText}>{ignore.label}</Text>
          </Pressable>
          <Text style={styles.hint}>{ignore.on ? "On" : "Off"}</Text>
        </View>
        {!micApi ? <Text style={styles.hint}>{PASEO_STOP_HINT}</Text> : null}
        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={chat.label}
            disabled={chat.disabled}
            onPress={() => state.jarvisAgentId && navigation?.openAgent({ agentId: state.jarvisAgentId })}
            style={[styles.action, chat.disabled ? styles.disabled : null]}
          >
            <Text style={styles.actionText}>{chat.label}</Text>
          </Pressable>
          {chat.reason ? <Text style={styles.hint}>{chat.reason}</Text> : null}
        </View>
        {voice.status === "ready" ? <Text style={styles.hint}>{voiceModelLine(voiceProfileFor(profiles, profileSetting), profileSetting)}</Text> : null}
        {offNotice ? <Text style={[styles.hint, styles.danger]}>{offNotice}</Text> : null}
        {view.kind === "paseo-voice" ? (
          <View style={styles.card}>
            <Text style={styles.sessionText}>{view.title}</Text>
            <Text style={styles.hint}>{view.notice}</Text>
            <Text style={styles.hint}>{voiceStatusLine(state.voiceGuess)}</Text>
          </View>
        ) : (
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={state.talking ? "Tap to send" : "Tap to talk"}
              disabled={!on}
              onPress={() => void runner.toggleTalk()}
              style={[styles.talk, state.talking ? styles.actionOn : null, !on ? styles.disabled : null]}
            >
              <Text style={styles.actionText}>{state.talking ? "Listening… tap to send" : "Tap to talk"}</Text>
            </Pressable>
            {state.talking ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Cancel recording" onPress={() => void runner.cancelTalk()} style={styles.action}>
                <Text style={styles.actionText}>Cancel</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              disabled={!awake || !state.session}
              onPress={() => runner.interrupt()}
              style={[styles.action, !awake || !state.session ? styles.disabled : null]}
            >
              <Text style={styles.actionText}>Interrupt</Text>
            </Pressable>
          </View>
        )}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: settingsOpen }}
        onPress={() => setSettingsOpen((open) => !open)}
        style={styles.settingsToggle}
      >
        <Text style={styles.section}>{settingsOpen ? "Sessions & settings ▾" : "Sessions & settings ▸"}</Text>
      </Pressable>
      {settingsOpen ? (
        <ScrollView style={styles.settings} contentContainerStyle={styles.settingsBody}>
          <SessionsAndSettings theme={theme} compact={compact} runner={runner} styles={styles} />
        </ScrollView>
      ) : null}
    </>
  );
}

function SessionsAndSettings({ theme, compact, runner, styles }: { theme: Theme; compact: boolean; runner: VoiceRunner; styles: Styles }) {
  const state = useRunner(runner);
  const settings = useSettings(voiceSettings);
  const profiles = useAgentProfiles();
  const on = state.micOn;
  const ignore = ignoreMeView(state.ignoring);
  return (
    <>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: ignore.on }}
          accessibilityLabel={ignore.action}
          onPress={() => void runner.setMic(state.ignoring)}
          style={[styles.action, ignore.on ? styles.actionOn : null]}
        >
          <Text style={styles.actionText}>{ignore.label}</Text>
        </Pressable>
        <Text style={styles.hint}>{ignore.status ?? "Off"}</Text>
      </View>

      <Text style={styles.section}>Voice sessions</Text>
      {settings.status === "ready" ? (
        <>
          <Text style={styles.hint}>{voiceModelLine(voiceProfileFor(profiles, settings.values.profile), settings.values.profile)}</Text>
          <ProfileChips
            theme={theme}
            compact={compact}
            label="Model"
            accessibilityLabel="Voice session model"
            profiles={[...profiles, OFF_CHIP]}
            selectedId={voiceChipId(profiles, settings.values.profile)}
            autoLabel="Auto"
            describe={(profile) => (profile.id === OFF_CHIP.id ? "Leave new voice sessions on the Paseo default" : `Run new voice sessions on ${profileCaption(profile)}`)}
            onPick={(id) => {
              const value = id === OFF_CHIP.id ? "off" : id;
              if (value !== settings.values.profile) void settings.save({ ...settings.values, profile: value }, settings.revision);
            }}
          />
          {settings.saveError ? <Text style={[styles.hint, styles.danger]}>{settings.saveError}</Text> : null}
        </>
      ) : (
        <Text style={styles.hint}>{settings.status === "loading" ? "Voice sessions…" : settings.error}</Text>
      )}
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New voice session"
          disabled={!state.session}
          onPress={() => runner.newSession()}
          style={[styles.action, !state.session ? styles.disabled : null]}
        >
          <Text style={styles.actionText}>New voice session</Text>
        </Pressable>
        <Text style={styles.hint}>{state.session ? `In ${state.session.name}'s workspace` : "Pick a session first"}</Text>
      </View>

      <Text style={styles.section}>Sessions</Text>
      {state.sessions.length === 0 ? <Text style={styles.hint}>No sessions yet.</Text> : null}
      {state.sessions.map((session) => {
        const target = state.session?.id === session.id;
        return (
          <Pressable
            key={session.id}
            accessibilityRole="button"
            accessibilityState={{ selected: target }}
            onPress={() => runner.pick(session)}
            style={[styles.session, target ? styles.sessionOn : null]}
          >
            <Text style={styles.sessionText}>{session.name}</Text>
            {target ? <Text style={styles.hint}>target</Text> : null}
          </Pressable>
        );
      })}

      <VoiceInterpretPanel theme={theme} enabled={state.helper} onToggle={(next) => runner.setHelper(next)} history={state.interprets} />
    </>
  );
}

function createStyles(theme: Theme, compact: boolean) {
  const c = theme.colors;
  const pad = 16;
  return {
    overlay: {
      // Above the dashboard header, which sits at zIndex 10 so its menus clear the tab body.
      zIndex: 20,
      position: "absolute" as const,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      flexDirection: "row" as const,
      justifyContent: "flex-end" as const,
    },
    backdrop: {
      position: "absolute" as const,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: "rgba(0, 0, 0, 0.32)",
    },
    panel: {
      backgroundColor: c.surface0,
      borderLeftWidth: 1,
      borderLeftColor: c.border,
      paddingTop: pad,
      gap: 8,
    },
    panelDocked: { width: PANEL_WIDTH, flexShrink: 0 },
    panelOverlay: {
      width: compact ? ("100%" as const) : PANEL_WIDTH,
      maxWidth: "100%" as const,
      height: "100%" as const,
      borderLeftWidth: compact ? 0 : 1,
    },
    strip: {
      width: 40,
      alignItems: "center" as const,
      gap: 10,
      paddingTop: 16,
      backgroundColor: c.surface0,
      borderLeftWidth: 1,
      borderLeftColor: c.border,
    },
    stripText: { color: c.foregroundMuted, fontSize: 16 },
    stripLabel: { color: c.foregroundMuted, fontSize: 10 },
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.foregroundMuted },
    dotOn: { backgroundColor: c.statusSuccess },
    dotListening: { backgroundColor: c.accent },
    header: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      paddingHorizontal: pad,
    },
    title: { color: c.foreground, fontSize: 18, fontWeight: "600" as const },
    headerButtonText: { color: c.foregroundMuted, fontSize: 16 },
    pad: { paddingHorizontal: pad },
    flex1: { flex: 1 },
    body: { padding: pad, gap: 10, paddingBottom: 16 },
    composer: { paddingHorizontal: pad, gap: 8 },
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10 },
    chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
    chip: {
      borderWidth: 1,
      borderColor: c.accent,
      borderRadius: 999,
      backgroundColor: c.surface2,
      paddingHorizontal: 10,
      paddingVertical: 3,
    },
    chipText: { color: c.foreground, fontFamily: "monospace", fontSize: 11.5 },
    jarvisMessage: { gap: 6, alignSelf: "flex-start" as const, maxWidth: "92%" as const },
    youMessage: {
      gap: 2,
      alignSelf: "flex-end" as const,
      maxWidth: "92%" as const,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      backgroundColor: c.surface1,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    input: {
      flex: 1,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 7,
      backgroundColor: c.surface1,
      color: c.foreground,
      fontSize: 13,
      paddingHorizontal: 10,
      paddingVertical: 7,
    },
    section: { color: c.foreground, fontSize: 13, fontWeight: "600" as const, marginTop: 6 },
    settingsToggle: { paddingHorizontal: pad, paddingBottom: 10 },
    settings: { maxHeight: 280 },
    settingsBody: { paddingHorizontal: pad, paddingBottom: 24, gap: 10 },
    hint: { color: c.foregroundMuted, fontSize: 12 },
    danger: { color: c.statusDanger },
    action: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 7,
      backgroundColor: c.surface1,
      paddingHorizontal: 12,
      paddingVertical: 7,
    },
    actionOn: { borderColor: c.accent, backgroundColor: c.surface2 },
    actionText: { color: c.foreground, fontSize: 12.5 },
    talk: {
      flex: 1,
      alignItems: "center" as const,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 7,
      backgroundColor: c.surface1,
      paddingVertical: 10,
    },
    disabled: { opacity: 0.4 },
    session: {
      flexDirection: "row" as const,
      justifyContent: "space-between" as const,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 7,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    sessionOn: { borderColor: c.accent, backgroundColor: c.surface2 },
    sessionText: { color: c.foreground, fontSize: 13 },
    card: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      backgroundColor: c.surface1,
      padding: 12,
      gap: 8,
    },
  };
}
