import { useMemo, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import type { createVoiceRunner } from "./voice-runner";
import { drawerMicView, hasMicApi } from "./voice-mic-model";
import { VoiceInterpretPanel } from "./voice-interpret-panel";
import { ProfileChips, useAgentProfiles } from "./runner-picker";
import { profileCaption, type AgentProfile } from "../shared/agent-profiles";
import { voiceSettings } from "../shared/settings";
import { CONFIRM_CANCEL } from "../shared/voice-loop";
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

// Header trigger for the Voice drawer.
export function VoiceButton({ theme, runner, open, onPress }: { theme: Theme; runner: VoiceRunner; open: boolean; onPress(): void }) {
  const styles = useMemo(() => createStyles(theme, false), [theme]);
  const state = useRunner(runner);
  const on = state.micOn;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={`Voice, ${on ? "on" : "off"}`}
      onPress={onPress}
      style={[styles.button, open ? styles.buttonOn : null]}
    >
      <View style={[styles.dot, on ? styles.dotOn : null]} />
      <Text style={styles.buttonText}>Voice</Text>
    </Pressable>
  );
}

export function VoiceDrawer({ theme, compact, runner, open, onClose }: { theme: Theme; compact: boolean; runner: VoiceRunner; open: boolean; onClose(): void }) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const state = useRunner(runner);
  const settings = useSettings(voiceSettings);
  const profiles = useAgentProfiles();
  if (!open) return null;
  const on = state.micOn;
  const awake = state.mode !== "asleep";
  const view = drawerMicView({ hasMicApi: hasMicApi(globalThis.navigator), error: state.error });
  const needsWhisper = view.error ? /whisper|ffmpeg|model/i.test(view.error) : false;

  return (
    <View style={styles.overlay}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close voice" onPress={onClose} style={styles.backdrop} />
      <View style={styles.drawer} accessibilityViewIsModal>
        <View style={styles.header}>
          <Text style={styles.title}>Voice</Text>
          <View style={styles.headerActions}>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose}>
              <Text style={styles.headerButtonText}>×</Text>
            </Pressable>
          </View>
        </View>
        <ScrollView style={styles.flex1} contentContainerStyle={styles.body}>
          {view.kind === "jarvis" ? (
            <View style={styles.card}>
              <Text style={styles.sessionText}>{view.title}</Text>
              <Text style={styles.hint}>{view.notice}</Text>
            </View>
          ) : (
            <>
            <View style={styles.row}>
              <Pressable
                accessibilityRole="switch"
                accessibilityState={{ checked: on }}
                accessibilityLabel={on ? "Turn the mic off" : "Turn the mic on"}
                onPress={() => void runner.setMic(!on)}
                style={[styles.action, on ? styles.actionOn : null]}
              >
                <Text style={styles.actionText}>{on ? "On" : "Off"}</Text>
              </Pressable>
              <Text style={styles.hint}>{on ? MODE_LABEL[state.mode] : "Off"}</Text>
            </View>
            </>
          )}

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

          {view.kind === "mic" ? (
            <>
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
            </>
          ) : null}

          {state.mode === "confirming" && state.confirm ? (
            <View style={styles.card}>
              <Text style={styles.sessionText}>{state.confirm.text}</Text>
              <View style={styles.row}>
                <Pressable accessibilityRole="button" onPress={() => runner.confirm(state.confirm?.word ?? "")} style={styles.action}>
                  <Text style={styles.actionText}>{`Send "${state.confirm.word}"`}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={() => runner.confirm(CONFIRM_CANCEL)} style={styles.action}>
                  <Text style={styles.actionText}>Cancel</Text>
                </Pressable>
              </View>
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

          <VoiceInterpretPanel theme={theme} enabled={state.helper} onToggle={(next) => runner.setHelper(next)} history={state.interprets} />

          <Text style={styles.section}>Heard</Text>
          {state.transcripts.length === 0 ? <Text style={styles.hint}>Nothing yet.</Text> : null}
          {[...state.transcripts].reverse().map((entry, i) => (
            <View key={`${i}-${entry.text}`} style={styles.line}>
              <Text style={styles.sessionText}>{entry.text}</Text>
              <Text style={styles.hint}>{entry.outcome}</Text>
            </View>
          ))}

          <Text style={styles.section}>Replies</Text>
          {state.phoneActive ? <Text style={styles.hint}>Phone is speaking</Text> : null}
          {state.lines.length === 0 ? <Text style={styles.hint}>Nothing yet.</Text> : null}
          {[...state.lines].reverse().map((line, i) => (
            <Text key={`${i}-${line}`} style={styles.hint}>
              {line}
            </Text>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

function createStyles(theme: Theme, compact: boolean) {
  const c = theme.colors;
  const pad = compact ? 16 : 20;
  return {
    button: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      height: 30,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 7,
      backgroundColor: "transparent",
    },
    buttonOn: { borderColor: c.accent, backgroundColor: c.surface2 },
    buttonText: { color: c.foreground, fontSize: 12.5 },
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.foregroundMuted },
    dotOn: { backgroundColor: c.statusSuccess },
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
    drawer: {
      width: compact ? ("100%" as const) : 380,
      maxWidth: "100%" as const,
      height: "100%" as const,
      backgroundColor: c.surface0,
      borderLeftWidth: compact ? 0 : 1,
      borderLeftColor: c.border,
      paddingTop: compact ? 16 : 20,
      gap: 8,
    },
    header: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 10,
      paddingHorizontal: pad,
    },
    title: { color: c.foreground, fontSize: 18, fontWeight: "600" as const },
    headerActions: { flexDirection: "row" as const, gap: 8, marginLeft: "auto" as const },
    headerButtonText: { color: c.foregroundMuted, fontSize: 13 },
    flex1: { flex: 1 },
    body: { padding: pad, gap: 10, paddingBottom: 40 },
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10 },
    section: { color: c.foreground, fontSize: 13, fontWeight: "600" as const, marginTop: 6 },
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
      paddingVertical: 12,
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
    line: { gap: 2 },
  };
}
