// The drawer's side of the Voice helper: start/stop/switch/interpret over the RPCs. The server owns the helper and its
// 3 s fallback; this only guards the transport, so a rejected or hung RPC still gives the words as heard.
import { namelessPassThrough, type InterpretOutcome } from "../shared/voice-interpreter";
import type { VoiceSession } from "../shared/voice-loop";
import { voiceHelperStart, voiceHelperStop, voiceHelperSwitch, voiceInterpret } from "../shared/voice-rpc";

export const HELPER_TRANSPORT_TIMEOUT_MS = 5000;

type Rpc = {
  (def: typeof voiceHelperStart | typeof voiceHelperStop, input: Record<string, never>): Promise<{ ok: boolean }>;
  (def: typeof voiceHelperSwitch, input: { enabled?: boolean }): Promise<{ enabled: boolean }>;
  (def: typeof voiceInterpret, input: { transcript: string; sessionId: string; sessions: VoiceSession[] }): Promise<InterpretOutcome>;
};

export type VoiceHelperClient = ReturnType<typeof createVoiceHelperClient>;

export function createVoiceHelperClient(rpc: Rpc) {
  return {
    start: () => rpc(voiceHelperStart, {}).then(() => undefined),
    stop: () => rpc(voiceHelperStop, {}).then(() => undefined),
    getEnabled: () => rpc(voiceHelperSwitch, {}).then((r) => r.enabled),
    setEnabled: (enabled: boolean) => rpc(voiceHelperSwitch, { enabled }).then((r) => r.enabled),
    async interpret(transcript: string, ctx: { sessionId: string; sessions: VoiceSession[] }): Promise<InterpretOutcome> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const raced = new Promise<InterpretOutcome | "timeout" | "error">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), HELPER_TRANSPORT_TIMEOUT_MS);
        rpc(voiceInterpret, { transcript, ...ctx }).then(resolve, () => resolve("error"));
      });
      const won = await raced;
      clearTimeout(timer);
      if (typeof won !== "string") return won;
      return { result: await namelessPassThrough.interpret(transcript), via: "passThrough", reason: won };
    },
  };
}
