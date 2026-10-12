import { CONFIRM_CANCEL, CONFIRM_TIMEOUT_MS, initialVoiceState, step, type InterpretResult, type VoiceEffect, type VoiceEvent, type VoiceSession, type VoiceState } from "../shared/voice-loop";

export const MAX_LINES = 20;
export const MAX_TRANSCRIPTS = 5;

export const MAX_HOLD_MS = 30_000;
export const MIN_HOLD_MS = 300;
// One timeout for the drawer and Jarvis.
export { CONFIRM_TIMEOUT_MS };
export const BASE_HINTS = ["merge", "Orchestrator", "Paseo", "Jarvis"];

/** Ports the runner carries effects out through. Recorder, transcriber and clock are optional. */
export type VoiceRunnerPorts = {
  link: { say(sessionId: string, text: string): Promise<unknown>; interrupt(sessionId: string): Promise<unknown>;
    /** Starts a voice session beside `target` and returns its id. */
    create?(target: VoiceSession): Promise<string>;
  };
  /** Turns an utterance into a result for the loop. Defaults to sending the text as heard. */
  interpreter?: (text: string) => Promise<InterpretResult>;
  /** The mic: open() when voice turns on, close() when it turns off; start() begins capturing; stop() ends it and returns base64 audio and how long it ran. */
  recorder?: { open?(): Promise<unknown> | unknown; close?(): Promise<unknown> | unknown; start(): Promise<unknown> | unknown; stop(): Promise<{ audio: string; ms: number }> };
  /** Audio plus hint words in, text out. */
  transcriber?: (audio: string, hints: string[]) => Promise<string>;
  /** Timer port; defaults to the global setTimeout. */
  clock?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
};

export type TranscriptEntry = { text: string; outcome: string };

export type VoiceSnapshot = VoiceState & { lines: string[]; transcripts: TranscriptEntry[]; error: string | null };

const passThrough = async (text: string): Promise<InterpretResult> => ({ type: "send", text });
const keepLast = <T>(list: T[], add: T[], max: number): T[] => [...list, ...add].slice(-max);

export function createVoiceRunner(ports: VoiceRunnerPorts) {
  const interpreter = ports.interpreter ?? passThrough;
  const clock = ports.clock ?? { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  const entries: Array<{ id: number; text: string; outcome: string }> = [];
  const waiting = new Map<number, number>(); // interpret seq -> entry id
  let nextEntry = 0;
  let confirmTimer: unknown = null;
  let choicesTimer: unknown = null;
  let lastSent: number | null = null;
  let confirmEntry: number | null = null; // the transcript that asked to confirm
  const listeners = new Set<() => void>();
  let snapshot: VoiceSnapshot = { ...initialVoiceState(), lines: [], transcripts: [], error: null };

  const publish = (patch: Partial<VoiceSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((l) => l());
  };

  const fail = (err: unknown) => publish({ error: err instanceof Error ? err.message : String(err) });

  const showEntries = () => publish({ transcripts: entries.map(({ text, outcome }) => ({ text, outcome })) });
  const setOutcome = (id: number, outcome: string) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    entry.outcome = outcome;
    showEntries();
  };
  const outcomeOf = (effects: VoiceEffect[]): string | null => {
    const send = effects.find((e) => e.type === "send");
    if (send) return `sent to ${send.session.name}`;
    if (effects.some((e) => e.type === "askConfirm")) return "asked to confirm";
    return null;
  };

  function perform(effect: VoiceEffect) {
    switch (effect.type) {
      case "send":
        ports.link.say(effect.session.id, effect.text).catch((err) => {
          if (lastSent !== null) setOutcome(lastSent, "error");
          fail(err);
        });
        return;
      case "interrupt":
        ports.link.interrupt(effect.session.id).catch(fail);
        return;
      case "create": {
        const create = ports.link.create;
        if (!create) return fail(new Error("This Paseo can't start a session from here."));
        create.call(ports.link, effect.session).then(
          (id) => dispatch({ type: "pick", session: { id, name: `${effect.session.name} (voice)` } }),
          fail,
        );
        return;
      }
      case "interpret":
        interpreter(effect.text).then(
          (result) => dispatch({ type: "interpreted", seq: effect.seq, result }),
          (err) => {
            fail(err);
            dispatch({ type: "interpreted", seq: effect.seq, result: { type: "drop" } });
          },
        );
        return;
      case "receipt":
      case "speak":
      case "askConfirm":
        publish({ lines: keepLast(snapshot.lines, [effect.line], MAX_LINES) });
        return;
      case "stopPlayback":
      case "listen":
      case "sleep":
        return;
    }
  }

  function dispatch(event: VoiceEvent) {
    const choicesBefore = snapshot.choices;
    const { state, effects } = step(snapshot, event);
    // Store the new state before any effect runs, so effects that dispatch see it.
    publish(state);
    if (state.mode === "confirming" && confirmTimer === null) {
      confirmTimer = clock.setTimeout(() => {
        confirmTimer = null;
        dispatch({ type: "confirm", word: CONFIRM_CANCEL });
      }, CONFIRM_TIMEOUT_MS);
    } else if (state.mode !== "confirming" && confirmTimer !== null) {
      clock.clearTimeout(confirmTimer);
      confirmTimer = null;
    }
    // A numbered list waits as long as a confirm for its number, then is forgotten.
    if (state.choices !== choicesBefore) {
      if (choicesTimer !== null) clock.clearTimeout(choicesTimer);
      choicesTimer = state.choices
        ? clock.setTimeout(() => {
            choicesTimer = null;
            dispatch({ type: "choicesExpired" });
          }, CONFIRM_TIMEOUT_MS)
        : null;
    }
    let entryId: number | null = null;
    if (event.type === "utterance" && event.text.trim()) {
      const interpret = effects.find((e) => e.type === "interpret");
      entryId = nextEntry++;
      entries.push({ id: entryId, text: event.text, outcome: outcomeOf(effects) ?? (interpret ? "working" : "dropped") });
      if (interpret) waiting.set(interpret.seq, entryId);
      entries.splice(0, Math.max(0, entries.length - MAX_TRANSCRIPTS));
      showEntries();
    } else if (event.type === "interpreted" && waiting.has(event.seq)) {
      const id = waiting.get(event.seq) as number;
      waiting.delete(event.seq);
      setOutcome(id, outcomeOf(effects) ?? "dropped");
      if (effects.some((e) => e.type === "askConfirm")) confirmEntry = id;
    }
    // A button or the timeout settles a confirm without a new transcript: mark the one that asked.
    const settled = event.type === "confirm" && state.mode !== "confirming" ? confirmEntry : null;
    if (settled !== null) setOutcome(settled, outcomeOf(effects) ?? "cancelled");
    if (state.mode !== "confirming") confirmEntry = null;
    if (effects.some((e) => e.type === "send")) lastSent = settled ?? entries.at(-1)?.id ?? null;
    effects.forEach(perform);
  }

  let holding = false;
  let started: Promise<void> = Promise.resolve();
  let holdTimer: unknown = null;
  let opening: Promise<boolean> | null = null; // the latest mic open, true once it worked

  const hints = () => [...new Set([...BASE_HINTS, ...snapshot.sessions.map((s) => s.name)])];

  // Opens the mic. A failure turns voice back off and leaves its reason as the one error shown.
  function openMic(): Promise<boolean> {
    const attempt: Promise<boolean> = new Promise((resolve) => resolve(ports.recorder?.open?.())).then(
      () => true,
      (err) => {
        // Only the latest open may turn voice off; an older one lost to an off/on.
        if (opening === attempt) {
          off();
          fail(err);
        }
        return false;
      },
    );
    opening = attempt;
    return attempt;
  }

  async function begin(recorder: NonNullable<VoiceRunnerPorts["recorder"]>) {
    // A tap while the mic is still opening waits for it; a failed open already turned voice off.
    if (opening && !(await opening)) return;
    if (snapshot.mode === "asleep") return;
    try {
      await recorder.start();
    } catch (err) {
      if (!recorder.open) throw err;
      // The mic was released since voice turned on: open it once more before giving up.
      if (!(await openMic())) return;
      await recorder.start();
    }
  }

  function startTalk() {
    const recorder = ports.recorder;
    if (holding || snapshot.mode === "asleep") return;
    if (!recorder) return fail(new Error("No microphone available."));
    holding = true;
    dispatch({ type: "speechStart" });
    // A forgotten tap still ends: the clip is sent at 30 s.
    holdTimer = clock.setTimeout(() => void endTalk(), MAX_HOLD_MS);
    started = begin(recorder);
    started.catch(() => undefined);
  }

  async function endTalk() {
    if (!holding) return;
    holding = false;
    clock.clearTimeout(holdTimer);
    let text = "";
    try {
      await started;
      const clip = await (ports.recorder as NonNullable<VoiceRunnerPorts["recorder"]>).stop();
      if (clip.ms >= MIN_HOLD_MS && ports.transcriber) text = await ports.transcriber(clip.audio, hints());
    } catch (err) {
      fail(err);
    }
    dispatch({ type: "utterance", text });
  }

  /** Tap to talk: the first tap starts recording, the next one stops and sends. */
  function toggleTalk() {
    return holding ? endTalk() : startTalk();
  }

  /** Stops a recording and throws it away. */
  async function cancelTalk() {
    if (!holding) return;
    holding = false;
    clock.clearTimeout(holdTimer);
    try {
      await started;
      await (ports.recorder as NonNullable<VoiceRunnerPorts["recorder"]>).stop();
    } catch {
      // Nothing was going to be sent anyway.
    }
    dispatch({ type: "utterance", text: "" });
  }

  function on() {
    dispatch({ type: "wake" });
    publish({ error: null });
    void openMic();
  }

  function off() {
    dispatch({ type: "sleep" });
    if (holdTimer !== null) clock.clearTimeout(holdTimer);
    holdTimer = null;
    holding = false;
    opening = null;
    try {
      Promise.resolve(ports.recorder?.close?.()).catch(fail);
    } catch (err) {
      fail(err);
    }
  }

  return {
    startTalk,
    endTalk,
    toggleTalk,
    cancelTalk,
    dispatch,
    getState: (): VoiceSnapshot => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    on,
    off,
    confirm: (word: string) => dispatch({ type: "confirm", word }),
    interrupt: () => dispatch({ type: "interrupt" }),
    /** `blocked` are Voice's own sessions (Jarvis, the Voice helper), never a target. */
    setSessions(list: VoiceSession[], blocked: VoiceSession[] = []) {
      // The pills resync often; only a real change should reach the loop and wake subscribers.
      const same = (a: VoiceSession[], b: VoiceSession[]) => a.length === b.length && a.every((s, i) => s.id === b[i]?.id && s.name === b[i]?.name);
      if (!same(list, snapshot.sessions) || !same(blocked, snapshot.blocked)) dispatch({ type: "sessions", list, blocked });
    },
    pick: (session: VoiceSession) => dispatch({ type: "pick", session }),
    /** The drawer's "New voice session" button: the same create the "new session" phrase makes, voice on or off. */
    newSession() {
      if (snapshot.session) perform({ type: "create", session: snapshot.session });
    },
  };
}
