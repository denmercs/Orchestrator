import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { usePaseo, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  agentRunnerSettings,
  pickProfile,
  profileCaption,
  profilesFromConfigGet,
  type AgentProfile,
} from "../shared/agent-runner";

type Theme = PluginSurfaceProps["theme"];

// The host's agent profiles, read once from Paseo's config; empty when it can't be read.
export function useAgentProfiles(): AgentProfile[] {
  const paseo = usePaseo();
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);

  const reload = useCallback(async () => {
    try {
      setProfiles(profilesFromConfigGet(await paseo.config.get()));
    } catch {
      setProfiles([]);
    }
  }, [paseo]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return profiles;
}

export function RunnerPicker({ theme, compact }: { theme: Theme; compact: boolean }) {
  const settings = useSettings(agentRunnerSettings);
  const profiles = useAgentProfiles();
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);

  if (settings.status === "loading") {
    return <Text style={styles.muted}>Runner…</Text>;
  }
  if (settings.status !== "ready") {
    return <Text style={styles.muted}>{settings.error}</Text>;
  }
  if (profiles.length === 0) {
    return <Text style={styles.muted}>No agent profiles. Add Claude, Kiro, or Cursor in Settings → Agents.</Text>;
  }

  const selected = pickProfile(profiles, settings.values.profileId) ?? profiles[0];

  async function choose(id: string) {
    if (settings.status !== "ready" || id === settings.values.profileId) {
      return;
    }
    await settings.save({ profileId: id }, settings.revision);
  }

  return (
    <ProfileChips
      theme={theme}
      compact={compact}
      label="Runner"
      accessibilityLabel="Agent runner"
      profiles={profiles}
      selectedId={selected?.id ?? ""}
      describe={(profile) => `Use ${profileCaption(profile)} for new sessions`}
      onPick={(id) => void choose(id)}
    />
  );
}

// A labelled row of profile chips, one selected. With `autoLabel`, a first chip stands for the
// empty id ("let the caller decide").
export function ProfileChips({
  theme,
  compact,
  label,
  accessibilityLabel,
  profiles,
  selectedId,
  autoLabel,
  describe,
  onPick,
}: {
  theme: Theme;
  compact: boolean;
  label: string;
  accessibilityLabel: string;
  profiles: AgentProfile[];
  selectedId: string;
  autoLabel?: string;
  describe(profile: AgentProfile): string;
  onPick(id: string): void;
}) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const chips: Array<{ id: string; name: string; hint: string }> = [
    ...(autoLabel === undefined ? [] : [{ id: "", name: autoLabel, hint: `${label}: ${autoLabel}` }]),
    ...profiles.map((profile) => ({ id: profile.id, name: profile.name, hint: describe(profile) })),
  ];

  return (
    <View style={styles.row} accessibilityLabel={accessibilityLabel}>
      <Text style={styles.label}>{label}</Text>
      {chips.map((chip) => {
        const on = chip.id === selectedId;
        return (
          <Pressable
            key={chip.id || "auto"}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={chip.hint}
            onPress={() => onPick(chip.id)}
            style={[styles.chip, on ? styles.chipOn : null]}
          >
            <Text style={[styles.chipText, on ? styles.chipTextOn : null]} numberOfLines={1}>
              {chip.name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function createStyles(theme: Theme, compact: boolean) {
  return {
    row: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      alignItems: "center" as const,
      gap: 8,
    },
    label: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
      marginRight: 4,
    },
    muted: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    chip: {
      paddingHorizontal: compact ? 10 : 12,
      paddingVertical: compact ? 6 : 7,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    },
    chipOn: {
      borderColor: theme.colors.accent,
      backgroundColor: theme.colors.surface2,
    },
    chipText: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    chipTextOn: {
      color: theme.colors.foreground,
      fontWeight: "600" as const,
    },
  };
}
