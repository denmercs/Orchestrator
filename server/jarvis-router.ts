// The Jarvis router: the Voice loop (shared/voice-loop.ts) run on the server for the Jarvis provider, the same
// loop the Voice drawer runs, so the phone and the Mac follow one set of rules and one wording
// (shared/voice-lines.ts). Each utterance is stepped through the loop and its effects become steers to the
// target plus lines to say back. The state is kept here, keyed by the router id in the session's persistence
// handle, because Paseo reopens the provider session whenever voice mode turns on or off.
import { CONFIRM_CANCEL, initialVoiceState, step, type VoiceEvent, type VoiceSession, type VoiceState } from "../shared/voice-loop";
import { namelessPassThrough, type Interpreter } from "../shared/voice-interpreter";
import { ASLEEP_NOTE, NOTHING_SENT, sendFailedLine, SLEEP_LINE } from "../shared/voice-lines";

/** A confirm left unanswered this long is dropped by the next utterance (voice round trips are slow). */
export const CONFIRM_EXPIRY_MS = 60_000;

export type JarvisRouterPorts = {
  /** Live sessions the router may send to, Jarvis sessions left out. */
  sessions(): Promise<VoiceSession[]>;
  /** Sends text to a session as a steer. */
  send(sessionId: string, text: string): Promise<unknown>;
  /**
   * Turns an utterance into a loop result. Defaults to the words as heard, minus a leading "Jarvis,".
   * The seam for the speech-cleanup helper: pass `withFallback(helper, namelessPassThrough)`, unwrapped to its result.
   */
  interpreter?: Interpreter;
  now?(): number;
};

/** `spoken` is said back (and shown); `note` is shown only, when there is nothing to say. */
export type RouteResult = { spoken: string[]; note: string | null };

type Entry = { state: VoiceState; confirmAt: number };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createJarvisRouter(ports: JarvisRouterPorts) {
  const now = ports.now ?? Date.now;
  const interpreter = ports.interpreter ?? namelessPassThrough;
  const entries = new Map<string, Entry>();
  const chains = new Map<string, Promise<unknown>>();
  let drawerTarget: VoiceSession | null = null;

  // A new router starts awake, on the drawer's target if there is one.
  function entryFor(routerId: string): Entry {
    let entry = entries.get(routerId);
    if (!entry) {
      entry = { state: step({ ...initialVoiceState(), session: drawerTarget }, { type: "wake" }).state, confirmAt: 0 };
      entries.set(routerId, entry);
    }
    return entry;
  }

  async function routeNow(routerId: string, text: string): Promise<RouteResult> {
    const entry = entryFor(routerId);
    let state = entry.state;
    const list = await ports.sessions().catch(() => null);
    if (list) state = step(state, { type: "sessions", list }).state;
    if (state.mode === "confirming" && now() - entry.confirmAt > CONFIRM_EXPIRY_MS) {
      state = step(state, { type: "confirm", word: CONFIRM_CANCEL }).state;
    }
    const wasConfirming = state.mode === "confirming";
    const spoken: string[] = [];
    const events: VoiceEvent[] = [{ type: "utterance", text }];
    for (let event = events.shift(); event; event = events.shift()) {
      const r = step(state, event);
      state = r.state;
      let failed = false;
      for (const effect of r.effects) {
        switch (effect.type) {
          case "interpret": {
            const result = await interpreter
              .interpret(effect.text, { transcript: effect.text, targetTitle: state.session?.name ?? null, recent: [], sessions: state.sessions })
              .catch(() => namelessPassThrough.interpret(effect.text));
            events.push({ type: "interpreted", seq: effect.seq, result });
            break;
          }
          case "send":
            try {
              await ports.send(effect.session.id, effect.text);
            } catch (error) {
              failed = true;
              spoken.push(sendFailedLine(effect.session.name, errorText(error)));
            }
            break;
          case "receipt":
            if (!failed) spoken.push(effect.line);
            break;
          case "speak":
          case "askConfirm":
            spoken.push(effect.line);
            break;
          case "sleep":
            spoken.push(SLEEP_LINE);
            break;
          case "interrupt":
          case "stopPlayback":
          case "listen":
            break;
        }
      }
    }
    if (state.mode === "confirming" && !wasConfirming) entry.confirmAt = now();
    entry.state = state;
    if (spoken.length) return { spoken, note: null };
    return { spoken, note: state.mode === "asleep" ? ASLEEP_NOTE : NOTHING_SENT };
  }

  return {
    /** One utterance (or typed message) at a time per router, so a confirm can't race its answer. */
    route(routerId: string, text: string): Promise<RouteResult> {
      const run = (chains.get(routerId) ?? Promise.resolve()).then(() => routeNow(routerId, text));
      chains.set(routerId, run.catch(() => undefined));
      return run;
    },
    /** The Voice drawer picked a target: every router follows it. */
    setTarget(session: VoiceSession) {
      drawerTarget = session;
      for (const entry of entries.values()) entry.state = step(entry.state, { type: "pick", session }).state;
    },
    /** A router's loop state, for tests. */
    stateOf: (routerId: string): VoiceState | null => entries.get(routerId)?.state ?? null,
  };
}

export type JarvisRouter = ReturnType<typeof createJarvisRouter>;
