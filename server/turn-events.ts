// Turn events, one source: maps Paseo's lifecycle events to Voice loop events (reply, notice). Pure, so the plugin
// server feeds the drawer and Jarvis from the same mapping. The loop decides what is spoken and when.
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { canTarget, type VoiceEvent } from "../shared/voice-loop";

type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];
type PermissionRequested = PluginLifecycleEvents["agent.permission_requested"];
type Agent = TurnEnded["agent"] & { labels?: Record<string, string> | null };

/** The final assistant message of the turn: the last one after the last user message. */
function finalReply(timeline: TurnEnded["timeline"]): string | null {
  const turnStart = timeline.map((item) => item.type).lastIndexOf("user_message") + 1;
  for (let i = timeline.length - 1; i >= turnStart; i--) {
    const item = timeline[i];
    if (item.type === "assistant_message") return item.text;
  }
  return null;
}

/** A finished turn replies and finishes, a failed one is an error, a canceled one is silent; Voice's own sessions never speak. */
/** `watched`: the session speaks its replies (voice pill menu) and the phone is its speaker, so the reply is heard whoever the target is; it replaces the finished notice, so it is said once. */
export function turnEvents(event: Omit<TurnEnded, "turnId"> & { agent: Agent }, options: { watched?: boolean } = {}): VoiceEvent[] {
  const sessionId = event.agent.id;
  if (!canTarget(event.agent)) return [];
  if (event.outcome.kind === "failed") return [{ type: "notice", kind: "error", sessionId }];
  if (event.outcome.kind !== "completed") return [];
  const text = finalReply(event.timeline);
  if (options.watched && text) return [{ type: "reply", sessionId, text, watched: true }];
  return [...(text ? [{ type: "reply" as const, sessionId, text }] : []), { type: "notice", kind: "finished", sessionId }];
}

/** A session waiting on a permission needs you. */
export function permissionEvents(event: Pick<PermissionRequested, "agent"> & { agent: Agent }): VoiceEvent[] {
  return canTarget(event.agent) ? [{ type: "notice", kind: "needsYou", sessionId: event.agent.id }] : [];
}
