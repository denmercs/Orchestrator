import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";

// Voice resume: in voice mode Paseo cancels the agent's turn as soon as its mic hears any sound, cutting
// a spoken reply short or killing a running tool call. When the sound was only noise, no transcript
// follows and the agent sits idle. This waits a quiet window after such a cut and, if no new turn has
// started, tells the agent to finish what it was saying or run the tool again.

export const RESUME_MESSAGE =
  "Background noise cut off your spoken reply; nobody spoke. Speak again only the part you hadn't finished, then carry on with what you were doing.";

// Claude reports the killed call as "the user doesn't want to proceed", so say plainly that nobody did.
export const TOOL_RESUME_MESSAGE =
  "Background noise cancelled your last tool call; nobody spoke and nothing was rejected. Run it again, then carry on with what you were doing.";

// Paseo's detector already needs about a second of silence to end an utterance, and a real utterance starts
// a new turn that cancels the pending resume, so a short wait is enough.
export const RESUME_QUIET_MS = 3_000;

// Cuts in a row that are resumed before giving up, so constant noise can't loop the agent.
export const MAX_RESUMES_IN_A_ROW = 3;

type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];

export type ResumePort = {
  send(agentId: string, text: string): Promise<void>;
};

const isSpeak = (name: string) => /(^|__)speak$/.test(name);

// A canceled turn whose last tool call never completed: a speak whose playback was cut, or any other tool.
// Only calls since the last user message count, so a call left unfinished by an earlier turn doesn't.
// Another tool only counts once the session has spoken: a typed session's Stop mid-Bash is left alone.
export function noiseCut(event: TurnEnded): "speech" | "tool" | null {
  if (event.outcome.kind !== "canceled") return null;
  const timeline = event.timeline;
  const turnStart = timeline.map((item) => item.type).lastIndexOf("user_message") + 1;
  const calls = timeline.slice(turnStart).filter((item) => item.type === "tool_call");
  const last = calls[calls.length - 1];
  if (!last || last.status === "completed") return null;
  if (isSpeak(last.name)) return "speech";
  return timeline.some((item) => item.type === "tool_call" && isSpeak(item.name)) ? "tool" : null;
}

export function createVoiceResume(port: ResumePort, quietMs = RESUME_QUIET_MS) {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  // Resumes sent per agent since its last turn that ended without a cut.
  const resumes = new Map<string, number>();

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
      const cut = noiseCut(event);
      const count = resumes.get(agentId) ?? 0;
      if (!cut || count >= MAX_RESUMES_IN_A_ROW) {
        resumes.delete(agentId);
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(agentId);
        resumes.set(agentId, count + 1);
        port.send(agentId, cut === "speech" ? RESUME_MESSAGE : TOOL_RESUME_MESSAGE).catch((error) => {
          if (count) resumes.set(agentId, count);
          else resumes.delete(agentId);
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
