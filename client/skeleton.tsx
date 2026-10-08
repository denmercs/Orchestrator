import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Animated, View, type DimensionValue } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

type Theme = PluginSurfaceProps["theme"];

const PULSE_MS = 900;
const DIM = 0.45;

// Wraps skeleton bars and pulses them together: one loop per wrapper, stopped on unmount.
export function Skeleton({ children }: { children: ReactNode }) {
  const opacity = useRef(new Animated.Value(DIM)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: PULSE_MS, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: DIM, duration: PULSE_MS, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}

export function SkeletonBar({
  theme,
  width = "100%",
  height = 12,
}: {
  theme: Theme;
  width?: DimensionValue;
  height?: number;
}) {
  return <View style={{ width, height, borderRadius: 6, backgroundColor: theme.colors.surface2 }} />;
}

// Text-like rows: the last row is shorter, like the end of a paragraph or list.
export function SkeletonRows({ theme, rows = 3 }: { theme: Theme; rows?: number }) {
  const styles = useMemo(() => createStyles(false), []);
  return (
    <Skeleton>
      <View style={styles.stack}>
        {Array.from({ length: rows }, (_, i) => (
          <SkeletonBar key={i} theme={theme} width={i === rows - 1 && rows > 1 ? "60%" : "100%"} />
        ))}
      </View>
    </Skeleton>
  );
}

// Card blocks: a row of tiles on wide screens, a stack when compact.
export function SkeletonCards({
  theme,
  count = 3,
  height = 72,
  compact = false,
}: {
  theme: Theme;
  count?: number;
  height?: number;
  compact?: boolean;
}) {
  const styles = useMemo(() => createStyles(compact), [compact]);
  return (
    <Skeleton>
      <View style={styles.cards}>
        {Array.from({ length: count }, (_, i) => (
          <View key={i} style={styles.card}>
            <SkeletonBar theme={theme} height={height} />
          </View>
        ))}
      </View>
    </Skeleton>
  );
}

function createStyles(compact: boolean) {
  return {
    stack: {
      gap: 10,
    },
    cards: {
      flexDirection: compact ? ("column" as const) : ("row" as const),
      gap: 12,
    },
    card: {
      flex: compact ? undefined : 1,
    },
  };
}
