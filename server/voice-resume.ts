import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";

// Voice resume: Paseo cuts a spoken reply short as soon as its mic hears any sound, and cancels the
// agent's turn with it. When the sound was only noise, no transcript follows and the agent sits
// silent mid-sentence. This waits a quiet window after such a cut and, if no new turn has started,
// tells the agent to finish what it was saying.

export const RESUME_MESSAGE =
  "Background noise cut off your spoken reply; nobody spoke. Speak again only the part you hadn't finished, then carry on with what you were doing.";

// Long enough for a real utterance to end and be transcribed into a new turn, which cancels the resume.
export const RESUME_QUIET_MS = 10_000;

type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];

export type ResumePort = {
  send(agentId: string, text: string): Promise<void>;
};

// A canceled turn whose last tool call is a speak that never completed: playback was cut, not finished.
export function cutMidSpeech(event: TurnEnded): boolean {
  if (event.outcome.kind !== "canceled") return false;
  const calls = event.timeline.filter((item) => item.type === "tool_call");
  const last = calls[calls.length - 1];
  return !!last && /(^|__)speak$/.test(last.name) && last.status !== "completed";
}

export function createVoiceResume(port: ResumePort, quietMs = RESUME_QUIET_MS) {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  // Agents whose last turn was itself a resume: a second cut in a row isn't resumed, so noise can't loop it.
  const resumed = new Set<string>();

  function cancel(agentId: string) {
    const timer = pending.get(agentId);
    if (timer) clearTimeout(timer);
    pending.delete(agentId);
  }

  return {
    onTurnStarted(agentId: string) {
      cancel(agentId);
    },
    onTurnEnded(event: TurnEnded) {
      const agentId = event.agent.id;
      cancel(agentId);
      if (!cutMidSpeech(event) || resumed.has(agentId)) {
        resumed.delete(agentId);
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(agentId);
        resumed.add(agentId);
        port.send(agentId, RESUME_MESSAGE).catch((error) => {
          resumed.delete(agentId);
          console.warn("orchestrator: voice resume failed", error);
        });
      }, quietMs);
      timer.unref?.();
      pending.set(agentId, timer);
    },
    stop() {
      for (const agentId of [...pending.keys()]) cancel(agentId);
    },
  };
}
