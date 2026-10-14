import { useEffect } from "react";
import { Text, View } from "react-native";
import { z } from "zod";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { createLineGate, shouldSpeakHere } from "./voice-line-model";

// The data Jarvis puts on a `voice-line` timeline item (server/jarvis-provider.ts).
export const voiceLineSchema = z.object({ lineId: z.string(), text: z.string() });
export type VoiceLineData = z.infer<typeof voiceLineSchema>;
type Speaker = { speak(text: string, replyId: string): Promise<unknown> };

// A small chat item that shows the line and, on a phone, says it once through the sentence player.
export function createVoiceLineRenderer(speaker: Speaker) {
  const gate = createLineGate(Date.now());
  return function VoiceLine({ item, theme, layout, timestamp }: PluginTimelineItemProps<VoiceLineData>) {
    const { lineId, text } = item.data;
    useEffect(() => {
      if (!shouldSpeakHere(layout.platform) || !gate.claim(lineId, timestamp.getTime())) return;
      speaker.speak(text, lineId).catch((error) => console.warn("orchestrator: voice line not spoken", error));
    }, [lineId, text, layout.platform, timestamp]);
    return (
      <View style={{ paddingVertical: 4 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{text}</Text>
      </View>
    );
  };
}
