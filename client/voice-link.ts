import type { PaseoAgentSendOptions } from "@getpaseo/client";

export const INTERRUPT_MESSAGE = "Stopped from the Voice drawer. Wait for my next message.";

// The slice of `client.paseo.agents` the link uses, so a fake can stand in for it in tests.
export type VoiceAgents = {
  ref(id: string): { send(text: string, options?: PaseoAgentSendOptions): Promise<unknown> };
};

// The Session link: speech goes into a running turn as a steer and never cuts it off.
// Only `interrupt` sends "interrupt", and only when the user asks for it.
export function createVoiceLink(agents: VoiceAgents) {
  return {
    say: (sessionId: string, text: string) =>
      agents.ref(sessionId).send(text, { activeTurnBehavior: "steer" }),
    interrupt: (sessionId: string) =>
      agents.ref(sessionId).send(INTERRUPT_MESSAGE, { activeTurnBehavior: "interrupt" }),
  };
}
