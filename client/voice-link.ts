import { VOICE_ROUTING_PREAMBLE, VOICE_SESSION_ENV } from "../shared/voice-session";

export const INTERRUPT_MESSAGE = "Stopped from the Voice drawer. Wait for my next message.";

// Typed here, not imported: a plugin's client code may not import "@getpaseo/client", and Paseo's build fails if it does.
type SendOptions = { activeTurnBehavior?: "steer" | "interrupt" };

type CreateOptions = { config: { provider: string }; env: Record<string, string> };

// The slice of `client.paseo` the link uses, so a fake can stand in for it in tests.
export type VoicePaseo = {
  agents: {
    ref(id: string): {
      send(text: string, options?: SendOptions): Promise<unknown>;
      refresh(): Promise<{ agent: { cwd: string; provider: string; workspaceId?: string | null } } | null | undefined>;
    };
    create(options: CreateOptions & { cwd: string }): Promise<{ id: string }>;
  };
  workspaces: { ref(id: string): { agents: { create(options: CreateOptions): Promise<{ id: string }> } } };
};

// The Session link: speech goes into a running turn as a steer and never cuts it off.
// Only `interrupt` sends "interrupt", and only when the user asks for it.
export function createVoiceLink({ agents, workspaces }: VoicePaseo) {
  // Sessions that already know the routing rule: ones this link created, and ones it has already told.
  const briefed = new Set<string>();
  return {
    say: (sessionId: string, text: string) => {
      const first = !briefed.has(sessionId);
      briefed.add(sessionId);
      return agents
        .ref(sessionId)
        .send(first ? `${VOICE_ROUTING_PREAMBLE}\n\n${text}` : text, { activeTurnBehavior: "steer" });
    },
    interrupt: (sessionId: string) =>
      agents.ref(sessionId).send(INTERRUPT_MESSAGE, { activeTurnBehavior: "interrupt" }),
    // A new voice session in the target's folder and workspace. Its system prompt carries the rule, so it is never briefed.
    async create(target: { id: string }): Promise<string> {
      const refreshed = await agents.ref(target.id).refresh();
      if (!refreshed) throw new Error("That session is gone.");
      const { cwd, provider, workspaceId } = refreshed.agent;
      // The provider only, never its model: the voice profile chooses the model (see applyVoiceSession).
      const options = { config: { provider }, env: { [VOICE_SESSION_ENV]: "1" } };
      const agent = workspaceId
        ? await workspaces.ref(workspaceId).agents.create(options)
        : await agents.create({ cwd, ...options });
      briefed.add(agent.id);
      return agent.id;
    },
  };
}
