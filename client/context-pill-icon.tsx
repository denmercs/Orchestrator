import { useEffect, useSyncExternalStore, type ComponentType } from "react";
import { View } from "react-native";
import type { PluginButtonIconProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import type { ContextToast, PillTone } from "./context-pill-model";

// What the context pill's icon reads. `version` changes whenever a tone or a queued toast does.
export type PillIconSource = {
  tone(agentId: string): PillTone;
  take(agentId: string): ContextToast[];
  version(): number;
  subscribe(listener: () => void): () => void;
};

// The context pill's icon: a dot in the level's colour (pills have no colour of their own). It is
// also where warnings toast, since `useToast` only works inside React: each time the source
// changes it shows whatever is queued for its session.
export function createContextPillIcon(source: PillIconSource): ComponentType<PluginButtonIconProps> {
  return function ContextPillIcon(props: PluginButtonIconProps) {
    const agentId = props.context === "agent" ? props.agentId : null;
    const version = useSyncExternalStore(source.subscribe, source.version);
    const toast = useToast();

    useEffect(() => {
      if (!agentId) return;
      for (const queued of source.take(agentId)) {
        if (queued.variant === "error") toast.error(queued.message);
        else toast.show(queued.message, { variant: queued.variant === "red" ? "error" : "warning" });
      }
    }, [agentId, version, toast]);

    const { colors } = props.theme;
    const tone = agentId ? source.tone(agentId) : "unknown";
    const color = {
      ok: colors.statusSuccess,
      amber: colors.statusWarning,
      red: colors.statusDanger,
      unknown: colors.foregroundMuted,
    }[tone];
    const size = Math.max(6, Math.round(props.size * 0.6));
    return (
      <View style={{ width: props.size, height: props.size, alignItems: "center", justifyContent: "center" }}>
        <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
      </View>
    );
  };
}
