import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { SpeakMode } from "../shared/speak-replies";
import { spokenLine } from "../shared/voice-lines";

type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];

// The Mac's voice: the one Speaker, played locally (server/voice-local.ts).
export type SpeakPorts = {
  speak: (text: string) => Promise<unknown>;
  hush: () => void;
};

function lastReply(timeline: TurnEnded["timeline"]): string {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.type === "assistant_message") return item.text;
  }
  return "";
}

// The sessions switched on to speak their replies, short, medium or full. In memory only, so a daemon restart turns them all off.
export function createSpeakReplies(ports: SpeakPorts) {
  const modes = new Map<string, Exclude<SpeakMode, "off">>();
  return {
    modes: () => Object.fromEntries(modes),
    has: (agentId: string) => modes.has(agentId),
    async set(agentId: string, mode: SpeakMode) {
      if (mode === "off") modes.delete(agentId);
      else modes.set(agentId, mode);
    },
    onTurnEnded(event: TurnEnded) {
      const mode = modes.get(event.agent.id);
      if (!mode || event.outcome.kind !== "completed") return;
      const line = spokenLine(lastReply(event.timeline), mode);
      if (line) void ports.speak(line).catch((error) => console.warn("orchestrator: speak failed", error));
    },
    // A new turn means the user sent something: stop talking over it.
    onTurnStarted(agentId: string) {
      if (modes.has(agentId)) ports.hush();
    },
  };
}
