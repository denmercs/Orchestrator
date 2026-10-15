import { HELPER_DEFAULT_ON, namelessPassThrough, type InterpretOutcome } from "../shared/voice-interpreter";
import { CONFIRM_CANCEL, CONFIRM_TIMEOUT_MS, initialVoiceState, step, type VoiceEffect, type VoiceEvent, type VoiceSession, type VoiceState } from "../shared/voice-loop";
import { phoneReplyLine } from "./voice-mic-model";
import { encodeWav } from "./voice-ears-model";

export const MAX_LINES = 20;
export const MAX_TRANSCRIPTS = 5;
export const MAX_CONVERSATION = 40;
export const MAX_INTERPRETS = 20;

export const MAX_HOLD_MS = 30_000;
export const MIN_HOLD_MS = 300;
// One timeout for the Jarvis panel (Mac) and Jarvis on the phone.
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
  /** The Voice helper (the server owns it): start/stop with voice, its switch, and interpret. Defaults to sending the text as heard. */
  helper?: {
    start(): Promise<unknown>;
    stop(): Promise<unknown>;
    getEnabled(): Promise<boolean>;
    setEnabled(enabled: boolean): Promise<boolean>;
    interpret(text: string, ctx: { sessionId: string; sessions: VoiceSession[] }): Promise<InterpretOutcome>;
  };
  /** The mic: open() when voice turns on, close() when it turns off; start() begins capturing; stop() ends it and returns base64 audio and how long it ran. */
  recorder?: { open?(): Promise<unknown> | unknown; close?(): Promise<unknown> | unknown; start(): Promise<unknown> | unknown; stop(): Promise<{ audio: string; ms: number }> };
  /** Audio plus hint words in, text out. */
  transcriber?: (audio: string, hints: string[]) => Promise<string>;
  /** Turn events from the plugin server: read(after) waits for events past the cursor. `phoneActive` means the phone is speaking. */
  events?: { read(after: number): Promise<{ cursor: number; events: VoiceEvent[]; phoneActive: boolean; voice?: VoiceGuess; settingsUnreadable?: boolean; settingsChecking?: boolean }> };
  /** Speaks a line aloud: resolves "ended" when it finished, "stopped" when stop() cut it off. */
  speaker?: { speak(text: string, replyId: string): Promise<"ended" | "stopped">; stop(): void };
  /** The morning briefing: lines to say when the words are "good morning" or an open briefing's answer, null when they are not. */
  brief?: (text: string) => Promise<string[] | null>;
  /** "Status": one line about the sessions' states when the words are a status ask, null when they are not. Tried after the briefing. */
  status?: (text: string) => Promise<string[] | null>;
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
  /** False on a device with no mic API (the phone): replies to the target are shown in the panel, not spoken. Defaults to true. */
  hasMic?: () => boolean;
  /** The persisted `voice.micOff` setting. */
  prefs?: {
    read(): Promise<{ micOff: boolean; unreadable?: boolean; transient?: boolean }>;
    write(micOff: boolean): Promise<unknown>;
    /** Re-saves the defaults over a setting that can't be read. */
    repair?(lastKnown?: boolean): Promise<unknown>;
  };
};

export type TranscriptEntry = { text: string; outcome: string };

export type InterpretRecord = { heard: string; outcome: InterpretOutcome };

export type ConversationEntry = { from: "you"; text: string; outcome: string } | { from: "jarvis"; text: string };

/** Best guess at whether Paseo voice mode is on; Paseo gives plugins no way to know for sure. */
export type VoiceGuess = "on" | "off" | "unknown";
export type VoiceSnapshot = VoiceState & { lines: string[]; conversation: ConversationEntry[]; transcripts: TranscriptEntry[]; interprets: InterpretRecord[]; helper: boolean; error: string | null; phoneActive: boolean; micOn: boolean; /** voice.micOff is on: what you say is dropped. Follows the saved pref only. */ ignoring: boolean; /** The mic should be on but could not open. */ micUnavailable: boolean; voiceGuess: VoiceGuess; /** The saved voice setting can't be read: Ignore me is off and the mic defaults to on. */ settingsUnreadable: boolean; /** The Jarvis session's agent id, for opening its Paseo chat. */ jarvisAgentId: string | null; /** The saved Ignore me value isn't known yet, so speech is held and the mic stays closed. */ settingsChecking: boolean };


export const AUTO_SLEEP_MS = 60_000;

const keepLast = <T>(list: T[], add: T[], max: number): T[] => [...list, ...add].slice(-max);

export function createVoiceRunner(ports: VoiceRunnerPorts) {
  const clock = ports.clock ?? { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  const entries: Array<{ id: number; text: string; outcome: string }> = [];
  const convo: Array<{ id?: number; from: "you" | "jarvis"; text: string; outcome?: string }> = []; // your words and Jarvis's lines, in order
  const waiting = new Map<number, number>(); // interpret seq -> entry id
  let nextEntry = 0;
  let nextReply = 0;
  let polling = 0; // bumped by on() and off(): a poll from an older run stops dispatching
  let confirmTimer: unknown = null;
  let choicesTimer: unknown = null;
  let lastSent: number | null = null;
  let confirmEntry: number | null = null; // the transcript that asked to confirm
  const listeners = new Set<() => void>();
  let snapshot: VoiceSnapshot = { ...initialVoiceState(), lines: [], conversation: [], transcripts: [], interprets: [], helper: HELPER_DEFAULT_ON, error: null, phoneActive: false, micOn: false, ignoring: false, micUnavailable: false, voiceGuess: "unknown", settingsUnreadable: false, jarvisAgentId: null, settingsChecking: false };
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

  const showConversation = (): Partial<VoiceSnapshot> => {
    convo.splice(0, Math.max(0, convo.length - MAX_CONVERSATION));
    return { conversation: convo.map((c): ConversationEntry => (c.from === "you" ? { from: "you", text: c.text, outcome: c.outcome ?? "" } : { from: "jarvis", text: c.text })) };
  };
  const showEntries = () => publish({ transcripts: entries.map(({ text, outcome }) => ({ text, outcome })), ...showConversation() });
  const setOutcome = (id: number, outcome: string) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    entry.outcome = outcome;
    const logged = convo.find((c) => c.id === id);
    if (logged) logged.outcome = outcome;
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
    convo.push({ from: "jarvis", text: line });
    publish({ lines: keepLast(snapshot.lines, [line], MAX_LINES), ...showConversation() });
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
        (ports.helper
          ? ports.helper.interpret(effect.text, { sessionId: snapshot.session?.id ?? "", sessions: snapshot.sessions })
          : namelessPassThrough.interpret(effect.text).then((result): InterpretOutcome => ({ result, via: "passThrough" }))
        ).then(
          (outcome) => {
            publish({ interprets: keepLast(snapshot.interprets, [{ heard: effect.text, outcome }], MAX_INTERPRETS) });
            dispatch({ type: "interpreted", seq: effect.seq, result: outcome.result });
          },
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
      case "show":
        convo.push({ from: "jarvis", text: effect.line });
        publish({ lines: keepLast(snapshot.lines, [effect.line], MAX_LINES), ...showConversation() });
        return;
      case "stopPlayback":
      case "sleep":
        ports.speaker?.stop();
        return;
      case "listen":
        warmHelper();
        return;
    }
  }

  // Words go to the briefing, then to the status ask (awake only): their lines are shown and spoken and the session
  // never hears them. If neither has anything for them, or one fails, they go to the loop as usual.
  function dispatch(event: VoiceEvent) {
    const answerers = [
      ports.brief && { ask: ports.brief, outcome: "briefing" },
      ports.status && { ask: ports.status, outcome: "status" },
    ].filter((a): a is { ask: (text: string) => Promise<string[] | null>; outcome: string } => !!a);
    if (!answerers.length || event.type !== "utterance" || !event.text.trim() || snapshot.mode === "asleep") return run(event);
    const text = event.text;
    const tryNext = (index: number): void => {
      const answerer = answerers[index];
      if (!answerer) return run(event);
      answerer.ask(text).then(
        (lines) => {
          if (!lines) return tryNext(index + 1);
          const id = nextEntry++;
          entries.push({ id, text, outcome: answerer.outcome });
          convo.push({ id, from: "you", text, outcome: answerer.outcome });
          entries.splice(0, Math.max(0, entries.length - MAX_TRANSCRIPTS));
          showEntries();
          lines.forEach((line) => showAndSpeak(line));
        },
        () => tryNext(index + 1),
      );
    };
    tryNext(0);
  }

  function run(event: VoiceEvent) {
    const choicesBefore = snapshot.choices;
    const modeBefore = snapshot.mode;
    const { state, effects } = step(snapshot, event);
    // Store the new state before any effect runs, so effects that dispatch see it.
    publish(state);
    ports.ears?.setAwake(state.mode === "listening" || state.mode === "confirming" || state.mode === "waiting");
    // Speaking risks the panel's own playback retriggering the VAD; pause the ears for it (a tap-to-talk hold
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
      const outcome = outcomeOf(effects) ?? (interpret ? "working" : "dropped");
      entries.push({ id: entryId, text: event.text, outcome });
      convo.push({ id: entryId, from: "you", text: event.text, outcome });
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
        if (batch.voice && batch.voice !== snapshot.voiceGuess) publish({ voiceGuess: batch.voice });
        if (batch.settingsUnreadable !== serverUnreadable || batch.settingsChecking !== serverChecking) {
          serverUnreadable = batch.settingsUnreadable;
          serverChecking = batch.settingsChecking;
          showSettingsState();
        }
        // One event at a time, in order: what Paseo voice mode heard is a "you" line (the loop never sees it). Asleep
        // the loop drops replies, so with no mic the panel shows them itself; awake, the loop shows them already.
        for (const e of batch.events) {
          if (e.type === "heard") {
            convo.push({ from: "you", text: e.text, outcome: "" });
            publish(showConversation());
            continue;
          }
          const line = ports.hasMic && !ports.hasMic() && snapshot.mode === "asleep" ? phoneReplyLine(e, snapshot.session?.id) : null;
          if (line !== null) {
            convo.push({ from: "jarvis", text: line });
            publish({ lines: keepLast(snapshot.lines, [line], MAX_LINES), ...showConversation() });
          }
          dispatch(e);
        }
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
    startRetry++;
    ports.helper?.stop().catch(fail);
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

  // The last Ignore me value actually read or saved (null: never). A glitch never changes it.
  let lastMicOff: boolean | null = null;
  // What this device read, and what the server reported, for the notice and the checking state; the server's wins once it answers.
  let localUnreadable = false;
  let localChecking = false;
  let serverUnreadable: boolean | undefined;
  let serverChecking: boolean | undefined;
  const showSettingsState = () =>
    publish({
      settingsUnreadable: serverUnreadable ?? localUnreadable,
      // A client that has a value is not checking, whatever a stale server flag says.
      settingsChecking: lastMicOff !== null ? false : (serverChecking ?? localChecking),
    });
  const RETRY_MS = 250;
  const MAX_RETRY_MS = 8_000;
  let startRetry = 0;

  // Applies a value that was actually read: opens the mic unless Ignore me is on.
  async function applySaved(saved: { micOff: boolean; unreadable?: boolean }) {
    if (ports.prefs) lastMicOff = saved.micOff;
    localUnreadable = saved.unreadable === true;
    localChecking = false;
    publish({ micOn: !saved.micOff, ignoring: saved.micOff, micUnavailable: false, error: null });
    showSettingsState();
    if (!saved.micOff && ports.ears) {
      try {
        await ports.ears.open();
      } catch {
        publish({ micOn: false, micUnavailable: true });
      }
    }
  }

  // A rejected read says nothing about the value: stay closed (no mic, speech held by the server) and ask again, longer each time.
  async function readSaved(run: number, attempt: number): Promise<void> {
    const saved = ports.prefs ? await ports.prefs.read().catch(() => ({ micOff: false, transient: true })) : { micOff: false, unreadable: false };
    if (run !== startRetry) return;
    if ("transient" in saved && saved.transient) {
      localChecking = true;
      publish({ micOn: false, ignoring: false, micUnavailable: false, error: null });
      showSettingsState();
      clock.setTimeout(() => void readSaved(run, attempt + 1), Math.min(RETRY_MS * 2 ** attempt, MAX_RETRY_MS));
      return;
    }
    await applySaved(saved);
  }

  /** Called once at launch: loads the mic pref, opens the mic and ears if it is on, and starts the events poll.
   * The loop itself stays asleep; a real wake word (or a tap) is what starts listening. A device with no mic (the
   * phone) fails quietly here, since that is expected rather than an error to show. */
  async function start() {
    await readSaved(++startRetry, 0);
    void poll(++polling);
  }

  /** The panel's mic switch: persists the pref, then opens or fully closes the mic and ears. Turning the mic off
   * also returns the loop to asleep, since there is no more audio to listen with. */
  async function setMic(on: boolean) {
    if (ports.prefs) await ports.prefs.write(!on);
    // A save is a value actually known, and repairs an unreadable setting.
    lastMicOff = !on;
    startRetry++;
    localUnreadable = false;
    localChecking = false;
    serverUnreadable = serverChecking = undefined;
    showSettingsState();
    if (!ports.ears) {
      publish({ micOn: on, ignoring: !on, micUnavailable: false });
      return;
    }
    if (on) {
      try {
        await ports.ears.open();
        publish({ micOn: true, ignoring: false, micUnavailable: false, error: null });
      } catch (err) {
        publish({ micOn: false, ignoring: false, micUnavailable: true });
        fail(err);
      }
      return;
    }
    publish({ micOn: false, ignoring: true, micUnavailable: false });
    dispatch({ type: "sleep" });
    try {
      await ports.ears.close();
    } catch (err) {
      fail(err);
    }
    ports.helper?.stop().catch(fail);
  }

  /** Voice woke: read the server's switch and start the helper, so the first answer doesn't wait on a cold start. */
  function warmHelper() {
    ports.helper?.getEnabled().then((helper) => publish({ helper }), fail);
    ports.helper?.start().catch(fail);
  }

  /** The panel's helper switch: shown at once, then the server's answer wins. */
  function setHelper(enabled: boolean) {
    publish({ helper: enabled });
    ports.helper?.setEnabled(enabled).then((helper) => publish({ helper }), fail);
  }

  return {
    setHelper,
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
    setSessions(list: VoiceSession[], blocked: VoiceSession[] = [], jarvis: VoiceSession[] = []) {
      const jarvisAgentId = jarvis[0]?.id ?? null;
      if (jarvisAgentId !== snapshot.jarvisAgentId) publish({ jarvisAgentId });
      // The pills resync often; only a real change should reach the loop and wake subscribers.
      const same = (a: VoiceSession[], b: VoiceSession[]) => a.length === b.length && a.every((s, i) => s.id === b[i]?.id && s.name === b[i]?.name);
      if (!same(list, snapshot.sessions) || !same(blocked, snapshot.blocked)) dispatch({ type: "sessions", list, blocked });
    },
    pick: (session: VoiceSession) => dispatch({ type: "pick", session }),
    /** Typed text: goes through the runner exactly like a transcript. Typing is deliberate, so it wakes a sleeping loop first. */
    type(text: string) {
      if (!text.trim()) return;
      if (snapshot.mode === "asleep") dispatch({ type: "wake" });
      dispatch({ type: "utterance", text, typed: true });
    },
    /** The notice's repair button: re-saves the defaults over a voice setting that can't be read. */
    async repairSettings() {
      try {
        await ports.prefs?.repair?.(lastMicOff ?? undefined);
        localUnreadable = false;
        serverUnreadable = false;
        showSettingsState();
      } catch (err) {
        fail(err);
      }
    },
    /** The panel's "New voice session" button: the same create the "new session" phrase makes, voice on or off. */
    newSession() {
      if (snapshot.session) perform({ type: "create", session: snapshot.session });
    },
  };
}
