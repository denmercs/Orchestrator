import { CONFIRM_CANCEL, CONFIRM_TIMEOUT_MS, initialVoiceState, step, withoutName, type InterpretResult, type VoiceEffect, type VoiceEvent, type VoiceSession, type VoiceState } from "../shared/voice-loop";
import { encodeWav } from "./voice-ears-model";

export const MAX_LINES = 20;
export const MAX_TRANSCRIPTS = 5;

export const MAX_HOLD_MS = 30_000;
export const MIN_HOLD_MS = 300;
// One timeout for the drawer and Jarvis.
export { CONFIRM_TIMEOUT_MS };
export const POLL_BACKOFF_MS = 2_000;
export const BASE_HINTS = ["merge", "Orchestrator", "Paseo", "Jarvis"];

export type EarsRunnerEvent = { type: "wake" } | { type: "speechStart" } | { type: "utterance"; pcm: Int16Array };

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
  /** Turn events from the plugin server: read(after) waits for events past the cursor. `phoneActive` means the phone is speaking. */
  events?: { read(after: number): Promise<{ cursor: number; events: VoiceEvent[]; phoneActive: boolean }> };
  /** Speaks a line aloud: resolves "ended" when it finished, "stopped" when stop() cut it off. */
  speaker?: { speak(text: string, replyId: string): Promise<"ended" | "stopped">; stop(): void };
  /** The morning briefing: lines to say when the words are "good morning" or an open briefing's answer, null when they are not. */
  brief?: (text: string) => Promise<string[] | null>;
  /** Timer port; defaults to the global setTimeout. */
  clock?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  /** The hands-free mic adapter: open/close the mic, told whether the loop is awake or a tap-to-talk is held, and
   * the source of `wake` / `speechStart` / `utterance` events. */
  ears?: {
    open(): Promise<unknown> | unknown;
    close(): Promise<unknown> | unknown;
    setAwake(awake: boolean): void;
    setPaused(paused: boolean): void;
    onEvent(fn: (event: EarsRunnerEvent) => void): void;
  };
  /** The persisted `voice.micOff` setting. */
  prefs?: { read(): Promise<{ micOff: boolean }>; write(micOff: boolean): Promise<unknown> };
};

export type TranscriptEntry = { text: string; outcome: string };

export type VoiceSnapshot = VoiceState & { lines: string[]; transcripts: TranscriptEntry[]; error: string | null; phoneActive: boolean; micOn: boolean };

export const AUTO_SLEEP_MS = 60_000;

const passThrough = async (text: string): Promise<InterpretResult> => ({ type: "send", text: withoutName(text) });
const keepLast = <T>(list: T[], add: T[], max: number): T[] => [...list, ...add].slice(-max);

export function createVoiceRunner(ports: VoiceRunnerPorts) {
  const interpreter = ports.interpreter ?? passThrough;
  const clock = ports.clock ?? { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  const entries: Array<{ id: number; text: string; outcome: string }> = [];
  const waiting = new Map<number, number>(); // interpret seq -> entry id
  let nextEntry = 0;
  let nextReply = 0;
  let polling = 0; // bumped by on() and off(): a poll from an older run stops dispatching
  let confirmTimer: unknown = null;
  let choicesTimer: unknown = null;
  let lastSent: number | null = null;
  let confirmEntry: number | null = null; // the transcript that asked to confirm
  const listeners = new Set<() => void>();
  let snapshot: VoiceSnapshot = { ...initialVoiceState(), lines: [], transcripts: [], error: null, phoneActive: false, micOn: false };
  let autoSleepTimer: unknown = null;
  const clearAutoSleep = () => {
    if (autoSleepTimer === null) return;
    clock.clearTimeout(autoSleepTimer);
    autoSleepTimer = null;
  };
  const armAutoSleep = () => {
    clearAutoSleep();
    autoSleepTimer = clock.setTimeout(() => {
      autoSleepTimer = null;
      dispatch({ type: "sleep" });
    }, AUTO_SLEEP_MS);
  };

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
    if (send) return "sent";
    if (effects.some((e) => e.type === "askConfirm")) return "asked to confirm";
    return null;
  };

  // Shows a line and plays it. `endsPlayback`: the loop is `speaking` until it has finished.
  function showAndSpeak(line: string, endsPlayback = false) {
    publish({ lines: keepLast(snapshot.lines, [line], MAX_LINES) });
    if (!ports.speaker) return;
    // The phone is speaking: the text stays on screen, but nothing plays here and the loop moves on.
    if (snapshot.phoneActive) return void (endsPlayback && dispatch({ type: "playbackEnded" }));
    ports.speaker.speak(line, `drawer-${nextReply++}`).then(
      (result) => result === "ended" && endsPlayback && dispatch({ type: "playbackEnded" }),
      fail,
    );
  }

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
      case "speak":
      case "askConfirm":
        showAndSpeak(effect.line, effect.type === "speak");
        return;
      case "stopPlayback":
      case "sleep":
        ports.speaker?.stop();
        return;
      case "listen":
        return;
    }
  }

  // Words go to the briefing first (awake only): its lines are shown and spoken and the session never hears them.
  // If it has nothing for them, or fails, they go to the loop as usual.
  function dispatch(event: VoiceEvent) {
    const brief = ports.brief;
    if (!brief || event.type !== "utterance" || !event.text.trim() || snapshot.mode === "asleep") return run(event);
    brief(event.text).then(
      (lines) => {
        if (!lines) return run(event);
        entries.push({ id: nextEntry++, text: event.text, outcome: "briefing" });
        entries.splice(0, Math.max(0, entries.length - MAX_TRANSCRIPTS));
        showEntries();
        lines.forEach((line) => showAndSpeak(line));
      },
      () => run(event),
    );
  }

  function run(event: VoiceEvent) {
    const choicesBefore = snapshot.choices;
    const modeBefore = snapshot.mode;
    const { state, effects } = step(snapshot, event);
    // Store the new state before any effect runs, so effects that dispatch see it.
    publish(state);
    ports.ears?.setAwake(state.mode === "listening" || state.mode === "confirming" || state.mode === "waiting");
    // Speaking risks the drawer's own playback retriggering the VAD; pause the ears for it (a tap-to-talk hold
    // already paused them and owns that flag while it lasts).
    if (!holding) ports.ears?.setPaused(state.mode === "speaking");
    // 60 s of listening with no speech goes back to asleep; the timer never runs outside listening.
    if (state.mode === "listening") {
      if (modeBefore !== "listening" || event.type === "speechStart" || event.type === "utterance") armAutoSleep();
    } else {
      clearAutoSleep();
    }
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
    if (holding) return;
    // Hands-free, asleep but the mic is on: a tap wakes the loop first, same as saying the name.
    if (snapshot.mode === "asleep") {
      if (!snapshot.micOn) return;
      dispatch({ type: "wake" });
    }
    if (!recorder) return fail(new Error("No microphone available."));
    holding = true;
    ports.ears?.setPaused(true);
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
    ports.ears?.setPaused(false);
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
    ports.ears?.setPaused(false);
    try {
      await started;
      await (ports.recorder as NonNullable<VoiceRunnerPorts["recorder"]>).stop();
    } catch {
      // Nothing was going to be sent anyway.
    }
    dispatch({ type: "utterance", text: "" });
  }

  // Ears events: asleep (or speaking, since the ears were told not-awake there too) a wake either starts
  // listening, or, while a reply is playing, is the barge-in (stop playback, start capturing). Awake, speechStart
  // and utterance follow the same path tap-to-talk uses.
  async function handleEarsUtterance(pcm: Int16Array) {
    let text = "";
    try {
      if (pcm.length > 0 && ports.transcriber) text = await ports.transcriber(encodeWav(pcm), hints());
    } catch (err) {
      fail(err);
    }
    dispatch({ type: "utterance", text });
  }
  ports.ears?.onEvent((event) => {
    switch (event.type) {
      case "wake":
        dispatch(snapshot.mode === "speaking" ? { type: "speechStart" } : { type: "wake" });
        return;
      case "speechStart":
        dispatch({ type: "speechStart" });
        return;
      case "utterance":
        void handleEarsUtterance(event.pcm);
        return;
    }
  });

  async function poll(run: number) {
    const events = ports.events;
    if (!events) return;
    let cursor = 0;
    while (polling === run) {
      try {
        const batch = await events.read(cursor);
        if (polling !== run) return;
        cursor = batch.cursor;
        if (batch.phoneActive !== snapshot.phoneActive) publish({ phoneActive: batch.phoneActive });
        batch.events.forEach(dispatch);
      } catch (err) {
        if (polling !== run) return;
        fail(err);
        await new Promise<void>((resolve) => clock.setTimeout(resolve, POLL_BACKOFF_MS));
      }
    }
  }

  function on() {
    dispatch({ type: "wake" });
    publish({ error: null });
    void openMic();
    void poll(++polling);
  }

  function off() {
    polling++;
    publish({ phoneActive: false });
    dispatch({ type: "sleep" });
    if (holdTimer !== null) clock.clearTimeout(holdTimer);
    holdTimer = null;
    holding = false;
    opening = null;
    try {
      Promise.resolve(ports.recorder?.close?.()).catch(fail);
      Promise.resolve(ports.ears?.close()).catch(fail);
    } catch (err) {
      fail(err);
    }
  }

  /** Called once at launch: loads the mic pref, opens the mic and ears if it is on, and starts the events poll.
   * The loop itself stays asleep; a real wake word (or a tap) is what starts listening. A device with no mic (the
   * phone) fails quietly here, since that is expected rather than an error to show. */
  async function start() {
    const micOff = ports.prefs ? (await ports.prefs.read()).micOff : false;
    publish({ micOn: !micOff, error: null });
    if (!micOff && ports.ears) {
      try {
        await ports.ears.open();
      } catch {
        publish({ micOn: false });
      }
    }
    void poll(++polling);
  }

  /** The drawer's mic toggle: persists the pref, then opens or fully closes the mic and ears. Turning the mic off
   * also returns the loop to asleep, since there is no more audio to listen with. */
  async function setMic(on: boolean) {
    if (ports.prefs) await ports.prefs.write(!on);
    if (!ports.ears) {
      publish({ micOn: on });
      return;
    }
    if (on) {
      try {
        await ports.ears.open();
        publish({ micOn: true, error: null });
      } catch (err) {
        publish({ micOn: false });
        fail(err);
      }
      return;
    }
    publish({ micOn: false });
    dispatch({ type: "sleep" });
    try {
      await ports.ears.close();
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
    start,
    setMic,
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
