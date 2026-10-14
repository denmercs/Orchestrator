import {
  HELPER_DEFAULT_ON,
  namelessPassThrough,
  withFallback,
  type InterpretOutcome,
  type Interpreter,
} from "../shared/voice-interpreter";
import type { VoiceSession } from "../shared/voice-loop";
import type { createVoiceHelper } from "./voice-helper";

// The one interpret service behind both surfaces (see CONTEXT.md, "Voice helper"): owns the switch,
// the helper's lifecycle and the fallback. Phone and Mac both call interpret() on every utterance.

export const INTERPRET_FALLBACK_MS = 3000;
export const IDLE_STOP_MS = 10 * 60 * 1000;

/** The helper's surface, injectable so tests use a fake. `createVoiceHelper(...)` fits as is. */
export type InterpretHelper = Pick<ReturnType<typeof createVoiceHelper>, "start" | "stop" | "interpret" | "agentId">;

export type InterpretRequest = { sessionId: string; sessions: VoiceSession[] };

export function createVoiceInterpret(helper: InterpretHelper) {
  let enabled = HELPER_DEFAULT_ON;
  let running = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const armIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      void stop();
    }, IDLE_STOP_MS);
    // Never keep the plugin server's process alive just for this.
    idleTimer.unref?.();
  };

  // Switch off: nothing would use the helper, so don't start one. Turning it on starts it on the next utterance.
  async function start() {
    if (!enabled) return;
    await helper.start();
    armIdle();
  }
  async function stop() {
    clearIdle();
    await helper.stop().catch(() => {});
  }
  async function warm() {
    if (helper.agentId()) return;
    await start().catch(() => {});
  }

  async function interpret(text: string, req: InterpretRequest): Promise<InterpretOutcome> {
    const passThrough = async (reason?: "starting" | "timeout"): Promise<InterpretOutcome> => ({
      result: (await namelessPassThrough.interpret(text)),
      via: "passThrough",
      ...(reason && { reason }),
    });
    if (!enabled) return passThrough();
    armIdle();
    if (!helper.agentId()) {
      void warm();
      return passThrough("starting");
    }
    // The previous run outlived its 3 s and is still going: don't queue behind it.
    if (running) return passThrough("timeout");
    const primary: Interpreter = {
      interpret: () => {
        running = true;
        const run = helper.interpret({ transcript: text, sessionId: req.sessionId, sessions: req.sessions });
        void run.then(
          () => (running = false),
          () => (running = false),
        );
        return run;
      },
    };
    return withFallback(primary, namelessPassThrough, { timeoutMs: INTERPRET_FALLBACK_MS }).interpret(text);
  }

  return { interpret, enabled: () => enabled, setEnabled: (on: boolean) => void (enabled = on), start, stop, warm };
}
