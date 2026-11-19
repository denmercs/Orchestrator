import { useEffect, useRef } from "react";
import { Text, View } from "react-native";
import type { PluginScreenProps } from "@getpaseo/plugin/client";

// Opens the Sulti session in Paseo's chat UI. Sidebar header items have no navigation; this screen bridges openAgent.
export function SultiChatBridge({ params, navigation, theme }: PluginScreenProps) {
  const agentId = params.agentId?.trim() ?? "";
  const opened = useRef(false);

  useEffect(() => {
    if (!agentId || !navigation || opened.current) return;
    opened.current = true;
    navigation.openAgent({ agentId });
  }, [agentId, navigation]);

  if (!agentId) {
    return (
      <View style={{ padding: 16, backgroundColor: theme.colors.surface0 }}>
        <Text style={{ color: theme.colors.foregroundMuted }}>No Sulti session.</Text>
      </View>
    );
  }

  return (
    <View style={{ padding: 16, backgroundColor: theme.colors.surface0 }}>
      <Text style={{ color: theme.colors.foregroundMuted }}>Opened Sulti in chat.</Text>
    </View>
  );
}