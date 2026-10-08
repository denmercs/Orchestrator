import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Animated, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { loadingVerse } from "./loading-verse-model";

type Theme = PluginSurfaceProps["theme"];

const FADE_MS = 400;

// Whole-screen first load: spinner, a verse that fades in, then the skeleton passed as children.
export function LoadingState({
  theme,
  compact,
  children,
}: {
  theme: Theme;
  compact: boolean;
  children?: ReactNode;
}) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  // Picked once per mount so the verse doesn't change mid-load.
  const [verse] = useState(() => loadingVerse(Math.floor(Math.random() * 1_000_000)));
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.timing(fade, { toValue: 1, duration: FADE_MS, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [fade]);

  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <ActivityIndicator size="small" color={theme.colors.accent} />
        <Animated.View style={[styles.verse, { opacity: fade }]}>
          <Text style={styles.quote}>{verse.text}</Text>
          <Text style={styles.reference}>{`${verse.reference} · BSB`}</Text>
        </Animated.View>
      </View>
      {children ? <View style={styles.body}>{children}</View> : null}
    </View>
  );
}

function createStyles(theme: Theme, compact: boolean) {
  return {
    root: {
      gap: compact ? 16 : 20,
    },
    head: {
      alignItems: "center" as const,
      gap: 10,
      paddingVertical: compact ? 12 : 16,
    },
    verse: {
      alignItems: "center" as const,
      gap: 4,
      maxWidth: 480,
    },
    quote: {
      color: theme.colors.foreground,
      fontStyle: "italic" as const,
      textAlign: "center" as const,
    },
    reference: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    body: {
      gap: 12,
    },
  };
}
