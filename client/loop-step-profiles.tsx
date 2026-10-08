import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { pickProfile, profileCaption, type AgentProfile } from "../shared/agent-runner";
import {
  initiativeLoopSettings,
  PROFILE_STEPS,
  STEP_LABELS,
  type ProfileStep,
} from "../shared/initiative-loop";
import { createStyles, ProfileChips, useAgentProfiles } from "./runner-picker";

type Theme = PluginSurfaceProps["theme"];

// Opens and closes the per-step panel; sits beside the Runner chips.
export function LoopProfilesToggle({
  theme,
  compact,
  open,
  onPress,
}: {
  theme: Theme;
  compact: boolean;
  open: boolean;
  onPress(): void;
}) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={`${open ? "Hide" : "Show"} loop profiles`}
      onPress={onPress}
      style={[styles.chip, open ? styles.chipOn : null]}
    >
      <Text style={[styles.chipText, open ? styles.chipTextOn : null]}>Loop profiles</Text>
    </Pressable>
  );
}

// One profile row per loop step that runs an agent. Auto (empty) lets the loop pick: an Opus profile
// for Plan and Review, a Sonnet one for Implement and Fix CI, else the runner's. An id that no longer
// matches a profile behaves as Auto, so Auto shows as selected.
export function LoopStepProfiles({ theme, compact }: { theme: Theme; compact: boolean }) {
  const settings = useSettings(initiativeLoopSettings);
  const profiles = useAgentProfiles();
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);

  if (settings.status === "loading") {
    return <Text style={styles.muted}>Loop profiles…</Text>;
  }
  if (settings.status !== "ready") {
    return <Text style={styles.muted}>{settings.error}</Text>;
  }

  async function choose(step: ProfileStep, id: string) {
    if (settings.status !== "ready" || id === settings.values.profiles[step]) {
      return;
    }
    const values = settings.values;
    await settings.save({ ...values, profiles: { ...values.profiles, [step]: id } }, settings.revision);
  }

  return (
    <View style={{ gap: 8 }} accessibilityLabel="Loop step profiles">
      {PROFILE_STEPS.map((step) => (
        <ProfileChips
          key={step}
          theme={theme}
          compact={compact}
          label={STEP_LABELS[step]}
          accessibilityLabel={`${STEP_LABELS[step]} profile`}
          profiles={profiles}
          selectedId={chosenId(profiles, settings.values.profiles[step])}
          autoLabel="Auto"
          describe={(profile) => `Run ${STEP_LABELS[step]} on ${profileCaption(profile)}`}
          onPick={(id) => void choose(step, id)}
        />
      ))}
      {settings.saveError ? <Text style={styles.muted}>{settings.saveError}</Text> : null}
    </View>
  );
}

// The chip to show as selected: the matching profile's id, or "" (Auto) when empty or unknown.
function chosenId(profiles: AgentProfile[], id: string) {
  return id ? (pickProfile(profiles, id)?.id ?? "") : "";
}
