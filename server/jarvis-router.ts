// The Jarvis router: the Voice loop (shared/voice-loop.ts) run on the server for the Jarvis provider, the same
// loop the Voice drawer runs, so the phone and the Mac follow one set of rules and one wording
// (shared/voice-lines.ts). Each utterance is stepped through the loop and its effects become steers to the
// target plus lines to say back. The state is kept here, keyed by the router id in the session's persistence
// handle, because Paseo reopens the provider session whenever voice mode turns on or off.
import { CONFIRM_CANCEL, CONFIRM_TIMEOUT_MS, initialVoiceState, step, type VoiceEvent, type VoiceSession, type VoiceState } from "../shared/voice-loop";
import { namelessPassThrough, type Interpreter } from "../shared/voice-interpreter";
import { ASLEEP_NOTE, NOTHING_SENT, notTargetLine, sendFailedLine, SLEEP_LINE, STOPPED_NOTE } from "../shared/voice-lines";

export type JarvisRouterPorts = {
  /** Live sessions: `list` may be targets, `blocked` are Voice's own (Jarvis, the Voice helper). See `splitSessions`. */
  sessions(): Promise<{ list: VoiceSession[]; blocked: VoiceSession[] }>;
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

type Entry = { state: VoiceState; confirmAt: number; choicesAt: number; owed: string[] };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createJarvisRouter(ports: JarvisRouterPorts) {
  const now = ports.now ?? Date.now;
  const interpreter = ports.interpreter ?? namelessPassThrough;
  const entries = new Map<string, Entry>();
  const chains = new Map<string, Promise<unknown>>();
  let drawerTarget: VoiceSession | null = null;
  let lastBlocked: VoiceSession[] = [];
  const refresh = async () => {
    const split = await ports.sessions().catch(() => null);
    if (split) lastBlocked = split.blocked;
    return split;
  };

  // A new router starts awake, on the drawer's target if there is one.
  function entryFor(routerId: string): Entry {
    let entry = entries.get(routerId);
    if (!entry) {
      entry = { state: step({ ...initialVoiceState(), session: drawerTarget }, { type: "wake" }).state, confirmAt: 0, choicesAt: 0, owed: [] };
      entries.set(routerId, entry);
    }
    return entry;
  }

  async function routeNow(routerId: string, text: string, signal?: AbortSignal): Promise<RouteResult> {
    const entry = entryFor(routerId);
    let state = entry.state;
    const split = await refresh();
    if (split) state = step(state, { type: "sessions", ...split }).state;
    // The same timeout as the drawer's, checked when the next words arrive (there is no timer on the phone).
    if (state.mode === "confirming" && now() - entry.confirmAt > CONFIRM_TIMEOUT_MS) {
      state = step(state, { type: "confirm", word: CONFIRM_CANCEL }).state;
    }
    // A numbered list expires the same way.
    if (state.choices && now() - entry.choicesAt > CONFIRM_TIMEOUT_MS) state = step(state, { type: "choicesExpired" }).state;
    const choicesBefore = state.choices;
    const wasConfirming = state.mode === "confirming";
    // Lines Jarvis couldn't say out of turn come first, once.
    const spoken: string[] = entry.owed.splice(0);
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
            // Interrupted before the steer went out: nothing is sent and the state is left as it was.
            if (signal?.aborted) return { spoken: [], note: STOPPED_NOTE };
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
    if (state.choices && state.choices !== choicesBefore) entry.choicesAt = now();
    entry.state = state;
    if (spoken.length) return { spoken, note: null };
    return { spoken, note: state.mode === "asleep" ? ASLEEP_NOTE : NOTHING_SENT };
  }

  return {
    /** One utterance (or typed message) at a time per router, so a confirm can't race its answer. */
    route(routerId: string, text: string, signal?: AbortSignal): Promise<RouteResult> {
      const run = (chains.get(routerId) ?? Promise.resolve()).then(() => routeNow(routerId, text, signal));
      chains.set(routerId, run.catch(() => undefined));
      return run;
    },
    /**
     * A turn event (reply, notice) goes through every router's loop; the lines each should say come back by router id.
     * A router whose loop says a line is left `speaking` until `playbackEnded`.
     */
    async event(event: VoiceEvent): Promise<Record<string, string[]>> {
      const split = await refresh();
      const lines: Record<string, string[]> = {};
      await Promise.all(
        [...entries.keys()].map((routerId) => {
          const run = (chains.get(routerId) ?? Promise.resolve()).then(() => {
            const entry = entryFor(routerId);
            const state = split ? step(entry.state, { type: "sessions", ...split }).state : entry.state;
            const r = step(state, event);
            entry.state = r.state;
            lines[routerId] = r.effects.flatMap((effect) => (effect.type === "speak" ? [effect.line] : []));
          });
          chains.set(routerId, run.catch(() => undefined));
          return run;
        }),
      );
      return lines;
    },
    /** What Jarvis said has finished playing (or failed to), so the loop is no longer `speaking`. */
    playbackEnded(routerId: string): void {
      const entry = entries.get(routerId);
      if (entry) entry.state = step(entry.state, { type: "playbackEnded" }).state;
    },
    /** Lines that couldn't be said out of turn: said first at the router's next words, once. */
    owe(routerId: string, lines: string[]): void {
      entryFor(routerId).owed.push(...lines);
    },
    /** The Voice drawer picked a target: every router follows it, unless it is one of Voice's own sessions. */
    async setTarget(session: VoiceSession): Promise<{ ok: boolean; line: string | null }> {
      const split = await refresh();
      if (lastBlocked.some((s) => s.id === session.id)) return { ok: false, line: notTargetLine(session.name) };
      drawerTarget = session;
      for (const entry of entries.values()) {
        const state = split ? step(entry.state, { type: "sessions", ...split }).state : entry.state;
        entry.state = step(state, { type: "pick", session }).state;
      }
      return { ok: true, line: null };
    },
    /** A router's loop state, for tests. */
    stateOf: (routerId: string): VoiceState | null => entries.get(routerId)?.state ?? null,
  };
}

export type JarvisRouter = ReturnType<typeof createJarvisRouter>;
