import { createVoiceSession, VOICE_ROUTING_PREAMBLE, type VoiceCreatePaseo } from "../shared/voice-session";

export const INTERRUPT_MESSAGE = "Stopped from the Voice drawer. Wait for my next message.";

// Typed here, not imported: a plugin's client code may not import "@getpaseo/client", and Paseo's build fails if it does.
type SendOptions = { activeTurnBehavior?: "steer" | "interrupt" };

// The slice of `client.paseo` the link uses, so a fake can stand in for it in tests.
export type VoicePaseo = {
  agents: Omit<VoiceCreatePaseo["agents"], "ref"> & {
    ref(id: string): ReturnType<VoiceCreatePaseo["agents"]["ref"]> & { send(text: string, options?: SendOptions): Promise<unknown> };
  };
  workspaces: VoiceCreatePaseo["workspaces"];
};

// The Session link: speech goes into a running turn as a steer and never cuts it off.
// Only `interrupt` sends "interrupt", and only when the user asks for it.
export function createVoiceLink(paseo: VoicePaseo) {
  const { agents } = paseo;
  // Sessions that already know the routing rule: ones this link created, and ones it has already told.
  const briefed = new Set<string>();
  return {
    // Briefed only once the steer lands, so a failed first send keeps the preamble for the retry.
    say: async (sessionId: string, text: string) => {
      const first = !briefed.has(sessionId);
      const sent = await agents
        .ref(sessionId)
        .send(first ? `${VOICE_ROUTING_PREAMBLE}\n\n${text}` : text, { activeTurnBehavior: "steer" });
      briefed.add(sessionId);
      return sent;
    },
    interrupt: (sessionId: string) =>
      agents.ref(sessionId).send(INTERRUPT_MESSAGE, { activeTurnBehavior: "interrupt" }),
    // A new voice session in the target's folder and workspace. Its system prompt carries the rule, so it is never briefed.
    async create(target: { id: string }): Promise<string> {
      const id = await createVoiceSession(paseo, target.id);
      briefed.add(id);
      return id;
    },
  };
}
