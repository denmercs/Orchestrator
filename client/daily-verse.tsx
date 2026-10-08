import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { getDailyVerse, type DailyVerse } from "../shared/orchestration";
import { verseLine } from "./daily-verse-model";

// Hourly is plenty: the verse only changes at midnight.
const VERSE_POLL_MS = 60 * 60 * 1000;

// One line under the header title: the quote truncates, the reference after it always shows.
export function InlineVerse({ theme }: { theme: PluginSurfaceProps["theme"] }) {
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
  const { quote, meta } = verseLine(verse);
  return (
    <View style={styles.row}>
      {quote ? (
        <Text style={styles.quote} numberOfLines={1} ellipsizeMode="tail">
          {quote}
        </Text>
      ) : null}
      <Text style={styles.meta}>{meta}</Text>
    </View>
  );
}

function createStyles(theme: PluginSurfaceProps["theme"]) {
  return {
    row: {
      flexDirection: "row" as const,
      alignItems: "baseline" as const,
      gap: 8,
    },
    quote: {
      flexShrink: 1,
      color: theme.colors.foreground,
      fontStyle: "italic" as const,
    },
    meta: {
      flexShrink: 0,
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
  };
}
