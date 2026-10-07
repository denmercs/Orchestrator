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

export function RunnerPicker({ theme, compact }: { theme: Theme; compact: boolean }) {
  const paseo = usePaseo();
  const settings = useSettings(agentRunnerSettings);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);

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

  async function choose(profile: AgentProfile) {
    if (settings.status !== "ready" || profile.id === settings.values.profileId) {
      return;
    }
    await settings.save({ profileId: profile.id }, settings.revision);
  }

  return (
    <View style={styles.row} accessibilityLabel="Agent runner">
      <Text style={styles.label}>Runner</Text>
      {profiles.map((profile) => {
        const on = profile.id === selected?.id;
        return (
          <Pressable
            key={profile.id}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`Use ${profileCaption(profile)} for new sessions`}
            onPress={() => void choose(profile)}
            style={[styles.chip, on ? styles.chipOn : null]}
          >
            <Text style={[styles.chipText, on ? styles.chipTextOn : null]} numberOfLines={1}>
              {profile.name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function createStyles(theme: Theme, compact: boolean) {
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
