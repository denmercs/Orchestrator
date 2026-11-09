// The Sulti router: the Voice loop (shared/voice-loop.ts) run on the server for the Sulti provider, the same
// loop the Mac's voice runner runs, so the phone and the Mac follow one set of rules and one wording
// (shared/voice-lines.ts). Each utterance is stepped through the loop and its effects become steers to the
// target plus lines to say back. The state is kept here, keyed by the router id in the session's persistence
// handle, because Paseo reopens the provider session whenever voice mode turns on or off.
import { isBriefGreeting, replyBrief, startBrief, type BriefData, type BriefState } from "../shared/morning-brief";
import { addressed, CONFIRM_CANCEL, CONFIRM_TIMEOUT_MS, initialVoiceState, step, type VoiceEvent, type VoiceSession, type VoiceState } from "../shared/voice-loop";
import { namelessPassThrough, type InterpretOutcome } from "../shared/voice-interpreter";
import { ASLEEP_NOTE, DIDNT_CATCH_NOTE, helperFallbackNote, newSessionFailedLine, NOTHING_SENT, SENT_NOTE, sendFailedLine, SLEEP_LINE, STOPPED_NOTE } from "../shared/voice-lines";
import { isFactoryStatusAsk, isStatusAsk, statusLine, type StatusAgent } from "../shared/voice-status";
import { createVoiceSession, VOICE_ROUTING_PREAMBLE, type VoiceCreatePaseo } from "../shared/voice-session";

/** The `create` port: a marked voice session beside the target. See `createVoiceSession`. */
export function voiceSessionCreator(paseo: () => VoiceCreatePaseo): (target: VoiceSession) => Promise<string> {
  return (target) => createVoiceSession(paseo(), target.id);
}

/** The interpret service's surface (server/voice-interpret.ts): `sessionId` is the target, whose recent messages the helper reads. */
export type SultiInterpreter = {
  interpret(text: string, req: { sessionId: string; sessions: VoiceSession[] }): Promise<InterpretOutcome>;
};

export type SultiRouterPorts = {
  /** Live sessions: `list` may be targets, `blocked` are Voice's own (Sulti, the Voice helper). See `splitSessions`. */
  sessions(): Promise<{ list: VoiceSession[]; blocked: VoiceSession[] }>;
  /** Sends text to a session as a steer. */
  send(sessionId: string, text: string): Promise<unknown>;
  /** Starts a marked voice session beside `target` and returns its id. See `voiceSessionCreator`. */
  create(target: VoiceSession): Promise<string>;
  /** Turns an utterance into a loop result plus how it got there. Defaults to the words as heard, minus a leading "Sulti,". */
  interpreter?: SultiInterpreter;
  /** The morning briefing: "good morning" gathers the data and walks through it, one beat per reply. */
  brief?: {
    gather(): Promise<BriefData>;
  };
  /** "Status": the live agents to summarise, from the same list as `sessions`. See `statusLine`. */
  status?(): Promise<StatusAgent[]>;
  /**
   * The id of the Sulti session (the global manager), or null when there is none. It shows in the list as "Sulti" and is the
   * target of a router that has none. It is never sent the routing preamble, since its system prompt covers it. Asked on every route;
   * a rejection is said, then routing is as with null.
   */
  sulti?(): Promise<string | null>;
  /**
   * The factory's status, answered by a cheap one-shot from its files: `answer` is spoken and nothing is sent, `unavailable`
   * carries why it can't run (routing carries on to Sulti, with a note), null means there is no factory. Read-only.
   */
  factoryStatus?(): Promise<{ answer: string } | { unavailable: string } | null>;
  now?(): number;
};

/** `spoken` is said back (and shown); `note` is shown only, after the spoken lines or alone when there are none. */
export type RouteResult = { spoken: string[]; note: string | null };

// A briefing waiting on your answer lapses after this, so a later "yes" isn't taken for it.
const BRIEF_TIMEOUT_MS = 120_000;

type Entry = { state: VoiceState; confirmAt: number; choicesAt: number; owed: string[]; sultiId: string | null };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The router id the Mac's "good morning" and "status" run under, kept apart from the phone routers.
export const MAC_ROUTER = "mac";

// The router id the dashboard's Sulti strip types under. The strip doesn't speak, so it is left out of listening, speaks and event.
export const DASHBOARD_ROUTER = "dashboard";

// The name the Sulti session answers to in the session list ("switch to Sulti").
const SULTI_SESSION_NAME = "Sulti";

export function createSultiRouter(ports: SultiRouterPorts) {
  const now = ports.now ?? Date.now;
  const interpreter: SultiInterpreter = ports.interpreter ?? {
    interpret: async (text) => ({ result: await namelessPassThrough.interpret(text), via: "passThrough" }),
  };
  const entries = new Map<string, Entry>();
  const chains = new Map<string, Promise<unknown>>();
  // Sessions that already know the routing rule: ones the router created, and ones it has already told.
  const told = new Set<string>();
  const briefs = new Map<string, { state: BriefState; at: number }>();
  const refresh = () => ports.sessions().catch(() => null);

  // A new router starts awake with no target: it picks one by voice.
  function entryFor(routerId: string): Entry {
    let entry = entries.get(routerId);
    if (!entry) {
      entry = { state: step(initialVoiceState(), { type: "wake" }).state, confirmAt: 0, choicesAt: 0, owed: [], sultiId: null };
      entries.set(routerId, entry);
    }
    return entry;
  }

  // The morning briefing runs ahead of the Voice loop: "good morning" starts it, and its answers are taken until
  // the words are not one (they then go on to the loop as usual). Null means the loop should have the words.
  async function routeBrief(routerId: string, text: string): Promise<RouteResult | null> {
    const brief = ports.brief;
    if (!brief) return null;
    const open = briefs.get(routerId);
    const live = open && now() - open.at <= BRIEF_TIMEOUT_MS ? open.state : null;
    if (!live) {
      briefs.delete(routerId);
      if (!isBriefGreeting(text)) return null;
      const entry = entryFor(routerId);
      // Asleep, only the name wakes it: a "good morning" to someone else in the room is not for Sulti.
      if (entry.state.mode === "asleep") {
        if (!addressed(text)) return null;
        entry.state = step(entry.state, { type: "wake" }).state;
      }
      let data: BriefData;
      try {
        data = await brief.gather();
      } catch (error) {
        return { spoken: [`I couldn't pull the briefing together: ${errorText(error)}`], note: null };
      }
      const started = startBrief(data);
      if (started.state) briefs.set(routerId, { state: started.state, at: now() });
      return { spoken: started.lines, note: null };
    }
    const next = replyBrief(live, text);
    if (next.passThrough) {
      briefs.delete(routerId);
      return null;
    }
    if (next.state) briefs.set(routerId, { state: next.state, at: now() });
    else briefs.delete(routerId);
    return { spoken: next.lines, note: null };
  }

  // "Status" is handled ahead of the loop, like the briefing: the loop only knows names, not what each session is doing.
  // Null means the words are not a status ask. Asleep, only the name wakes it.
  async function routeStatus(routerId: string, text: string): Promise<RouteResult | null> {
    const status = ports.status;
    if (!status || !isStatusAsk(text)) return null;
    const entry = entryFor(routerId);
    if (entry.state.mode === "asleep") {
      if (!addressed(text)) return null;
      entry.state = step(entry.state, { type: "wake" }).state;
    }
    try {
      return { spoken: [statusLine(await status())], note: null };
    } catch (error) {
      return { spoken: [`I couldn't read the sessions: ${errorText(error)}`], note: null };
    }
  }

  // "Where are we" and plain "status" go to the factory reporter ahead of the loop, so Sulti isn't woken to answer them.
  // Null means carry on: not an ask, no factory (plain "status" then reads the sessions), or asleep and not addressed.
  // `unavailable` is a note, and the words route on to the target as any other.
  async function routeFactoryStatus(routerId: string, text: string): Promise<RouteResult | { unavailable: string } | null> {
    const report = ports.factoryStatus;
    if (!report || !(isFactoryStatusAsk(text) || isStatusAsk(text))) return null;
    const entry = entryFor(routerId);
    if (entry.state.mode === "asleep" && !addressed(text)) return null;
    let reply: Awaited<ReturnType<NonNullable<SultiRouterPorts["factoryStatus"]>>>;
    try {
      reply = await report();
    } catch (error) {
      reply = { unavailable: errorText(error) };
    }
    if (!reply) return null;
    if ("unavailable" in reply) return reply;
    if (entry.state.mode === "asleep") entry.state = step(entry.state, { type: "wake" }).state;
    return { spoken: [reply.answer], note: null };
  }

  async function routeNow(routerId: string, text: string, signal?: AbortSignal, typed = false): Promise<RouteResult> {
    const briefed = await routeBrief(routerId, text);
    if (briefed) return briefed;
    const reported = await routeFactoryStatus(routerId, text);
    if (reported && "spoken" in reported) return reported;
    // Plain "status" with the reporter down still has its free session line; only the factory phrases need the reporter.
    const statused = reported && isFactoryStatusAsk(text) ? null : await routeStatus(routerId, text);
    if (statused) return reported ? { ...statused, note: `The status reporter is unavailable (${reported.unavailable}), so this shows the live sessions.` } : statused;
    // Empty speech (silence, a whisper the transcriber dropped) is not a routing failure.
    if (!text.trim()) return { spoken: [], note: DIDNT_CATCH_NOTE };
    const entry = entryFor(routerId);
    let state = entry.state;
    // A rejection (both model creates failed) is told apart from null (no Sulti session): the first is said, the second is silent.
    let sultiError: string | null = null;
    const [refreshed, sultiId] = await Promise.all([
      refresh(),
      ports.sulti
        ? ports.sulti().catch((error) => {
            sultiError = errorText(error);
            return null;
          })
        : null,
    ]);
    let split = refreshed;
    if (split && sultiId) split = { ...split, list: [...split.list.filter((s) => s.id !== sultiId), { id: sultiId, name: SULTI_SESSION_NAME }] };
    // Its system prompt carries the routing rule, so it is never briefed.
    if (sultiId) told.add(sultiId);
    const hadTarget = !!state.session;
    if (split) state = step(state, { type: "sessions", ...split }).state;
    // With no target, Sulti is the default one. A target that just went away is said, as an explicit switch is.
    // A target that is the Sulti session this router last saw, now replaced, is re-picked at the new id.
    const replaced = !!sultiId && !!state.session && !!entry.sultiId && state.session.id === entry.sultiId && entry.sultiId !== sultiId;
    if (sultiId) entry.sultiId = sultiId;
    if (replaced) state = { ...state, session: null };
    const landedOnSulti = !!split && !!sultiId && !state.session;
    if (landedOnSulti) state = step(state, { type: "pick", session: { id: sultiId, name: SULTI_SESSION_NAME } }).state;
    // The same timeout as the Mac's, checked when the next words arrive (there is no timer on the phone).
    if (state.mode === "confirming" && now() - entry.confirmAt > CONFIRM_TIMEOUT_MS) {
      state = step(state, { type: "confirm", word: CONFIRM_CANCEL }).state;
    }
    // A numbered list expires the same way.
    if (state.choices && now() - entry.choicesAt > CONFIRM_TIMEOUT_MS) state = step(state, { type: "choicesExpired" }).state;
    const choicesBefore = state.choices;
    const wasConfirming = state.mode === "confirming";
    // Lines Sulti couldn't say out of turn come first, once.
    const spoken: string[] = entry.owed.splice(0);
    if (sultiError) spoken.push(`I couldn't start Sulti: ${sultiError}`);
    if (landedOnSulti && hadTarget) spoken.push(`Now on ${SULTI_SESSION_NAME}.`);
    const shown: string[] = [];
    let steered = false;
    let steeredTo: string | null = null;
    let fallbackNote: string | null = null;
    // Typing is deliberate: it wakes a sleeping loop, and skips the short-text and helper filters.
    if (typed && state.mode === "asleep") state = step(state, { type: "wake" }).state;
    const events: VoiceEvent[] = [{ type: "utterance", text, ...(typed ? { typed } : {}) }];
    for (let event = events.shift(); event; event = events.shift()) {
      const r = step(state, event);
      state = r.state;
      for (const effect of r.effects) {
        switch (effect.type) {
          case "interpret": {
            const outcome: InterpretOutcome = await interpreter
              .interpret(effect.text, { sessionId: state.session?.id ?? "", sessions: state.sessions })
              .catch(async () => ({ result: await namelessPassThrough.interpret(effect.text), via: "passThrough" as const, reason: "error" as const }));
            fallbackNote ??= helperFallbackNote(outcome);
            const { result } = outcome;
            events.push({ type: "interpreted", seq: effect.seq, result });
            break;
          }
          case "send":
            // Interrupted before the steer went out: nothing is sent and the state is left as it was.
            if (signal?.aborted) return { spoken: [], note: STOPPED_NOTE };
            try {
              const first = !told.has(effect.session.id);
              await ports.send(effect.session.id, first ? `${VOICE_ROUTING_PREAMBLE}\n\n${effect.text}` : effect.text);
              told.add(effect.session.id);
              steered = true;
              steeredTo = effect.session.name;
            } catch (error) {
              spoken.push(sendFailedLine(effect.session.name, errorText(error)));
            }
            break;
          case "create":
            // The new session's system prompt carries the rule, so it is never briefed. A failure keeps the old target.
            try {
              const id = await ports.create(effect.session);
              told.add(id);
              events.push({ type: "pick", session: { id, name: `${effect.session.name} (voice)` } });
            } catch (error) {
              spoken.push(newSessionFailedLine(errorText(error)));
            }
            break;
          case "speak":
          case "askConfirm":
            spoken.push(effect.line);
            break;
          case "show":
            shown.push(effect.line);
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
    // Said from what happened, not from where the words were meant to go: the steer may have gone to another session, or nowhere.
    if (reported) fallbackNote = `The status reporter is unavailable (${reported.unavailable}), so ${steeredTo ? `this went to ${steeredTo}` : "nothing was sent"}.`;
    if (state.mode === "confirming" && !wasConfirming) entry.confirmAt = now();
    if (state.choices && state.choices !== choicesBefore) entry.choicesAt = now();
    entry.state = state;
    const shownNote = shown.length ? shown.join(" ") : null;
    if (spoken.length) return { spoken, note: fallbackNote ?? shownNote };
    // A shown line (no target picked) is text only, never said. A steer that went out is silent by design (no "Sent to ..."), but it was sent: never report "Nothing sent."
    return { spoken, note: fallbackNote ?? shownNote ?? (state.mode === "asleep" ? ASLEEP_NOTE : steered ? SENT_NOTE : NOTHING_SENT) };
  }

  return {
    /** One utterance (or typed message) at a time per router, so a confirm can't race its answer. */
    route(routerId: string, text: string, signal?: AbortSignal, opts?: { typed?: boolean }): Promise<RouteResult> {
      const run = (chains.get(routerId) ?? Promise.resolve()).then(() => routeNow(routerId, text, signal, opts?.typed === true));
      chains.set(routerId, run.catch(() => undefined));
      return run;
    },
    /**
     * The briefing alone, for the Mac (`MAC_ROUTER`): "good morning" and an open briefing's answers, on the same chain as
     * `route`. Null means the words are not for the briefing and the caller carries on.
     */
    brief(routerId: string, text: string): Promise<RouteResult | null> {
      const run = (chains.get(routerId) ?? Promise.resolve()).then(() => routeBrief(routerId, text));
      chains.set(routerId, run.catch(() => undefined));
      return run;
    },
    /** "Status" alone, for the Mac (`MAC_ROUTER`), on the same chain as `route`. Null means the words are not a status ask. */
    status(routerId: string, text: string): Promise<RouteResult | null> {
      const run = (chains.get(routerId) ?? Promise.resolve()).then(() => routeStatus(routerId, text));
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
        [...entries.keys()].filter((routerId) => routerId !== DASHBOARD_ROUTER).map((routerId) => {
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
    /** Whether any phone router's loop is awake: a watched reply is dropped by a sleeping loop, so the Mac must say it. The Mac's own briefing entry doesn't count. */
    listening(): boolean {
      return [...entries].some(([routerId, entry]) => routerId !== MAC_ROUTER && routerId !== DASHBOARD_ROUTER && entry.state.mode !== "asleep");
    },
    /** Whether a reply from this session can be said as the target's: it is some router's own target. */
    speaks(sessionId: string): boolean {
      return [...entries].some(([routerId, entry]) => routerId !== DASHBOARD_ROUTER && entry.state.session?.id === sessionId);
    },
    /** What Sulti said has finished playing (or failed to), so the loop is no longer `speaking`. */
    playbackEnded(routerId: string): void {
      const entry = entries.get(routerId);
      if (entry) entry.state = step(entry.state, { type: "playbackEnded" }).state;
    },
    /** Lines that couldn't be said out of turn: said first at the router's next words, once. A line already owed is not owed twice. */
    owe(routerId: string, lines: string[]): void {
      const owed = entryFor(routerId).owed;
      for (const line of lines) if (!owed.includes(line)) owed.push(line);
    },
    /** A router's loop state, for tests. */
    stateOf: (routerId: string): VoiceState | null => entries.get(routerId)?.state ?? null,
  };
}

export type SultiRouter = ReturnType<typeof createSultiRouter>;
