import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { getDailyVerse, type DailyVerse } from "../shared/orchestration";

// Hourly is plenty: the verse only changes at midnight.
const VERSE_POLL_MS = 60 * 60 * 1000;

export function DailyVerseCard({ theme }: { theme: PluginSurfaceProps["theme"] }) {
  const load = useRpc(getDailyVerse);
  const [verse, setVerse] = useState<DailyVerse | null>(null);
  const styles = useMemo(() => createStyles(theme), [theme]);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      load({})
        .then((next) => {
          if (active) {
            setVerse(next);
          }
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, VERSE_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [load]);

  if (!verse) {
    return null;
  }
  return (
    <View style={styles.card}>
      {verse.text ? <Text style={styles.text}>“{verse.text}”</Text> : null}
      <Text style={styles.reference}>
        {verse.reference}
        {verse.text ? `  ·  ${verse.translation}` : ""}
      </Text>
      {verse.text && verse.copyright ? <Text style={styles.copyright}>{verse.copyright}</Text> : null}
    </View>
  );
}

function createStyles(theme: PluginSurfaceProps["theme"]) {
  return {
    card: {
      gap: 6,
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
      borderRadius: 8,
    },
    text: {
      color: theme.colors.foreground,
      fontStyle: "italic" as const,
      lineHeight: 20,
    },
    reference: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    copyright: {
      color: theme.colors.foregroundMuted,
      fontSize: 10,
    },
  };
}
