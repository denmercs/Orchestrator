// The Voice loop: a pure state machine that decides everything the Voice drawer does.
// step(state, event) → { state, effects }. Adapters (mic, transcriber, interpreter, session link, speaker) only carry
// events in and effects out; the loop holds no clocks and imports only its own wording (voice-lines), so any
// bundle can reach it. The Voice runner (drawer, Mac) and the Jarvis router (phone) both run it.
import { CANCELLED, confirmLine, noSessionLine, notTargetLine, NOTHING_TO_CONFIRM, pickFirstLine, sentLine, spokenLine, switchedLine, WAKE_LINE, whichLine } from "./voice-lines";

export type VoiceMode = "asleep" | "listening" | "confirming" | "waiting" | "speaking";
export type VoiceSession = { id: string; name: string };
export type NoticeKind = "finished" | "needsYou" | "error" | "costCap";
export type Notice = { kind: NoticeKind; sessionId: string; name: string };

export type VoiceState = {
  mode: VoiceMode;
  session: VoiceSession | null;
  sessions: VoiceSession[];
  /** Voice's own sessions (Jarvis, the Voice helper): never a target, or Jarvis would steer itself. */
  blocked: VoiceSession[];
  talking: boolean;
  pending: { seq: number; heard: string } | null;
  confirm: { word: string; text: string } | null;
  /** The target's spoken reply, held while you talk or confirm. */
  held: string | null;
  queue: Notice[];
  seq: number;
};

/** What the interpreter helper (d1) made of an utterance. */
export type InterpretResult = { type: "send"; text: string } | { type: "confirm"; text: string } | { type: "switch"; name: string } | { type: "drop" };

export type VoiceEvent =
  | { type: "wake" }
  /** Every speechStart is followed by an utterance, empty when nothing was heard, so `talking` always ends. */
  | { type: "speechStart" }
  | { type: "utterance"; text: string }
  | { type: "interpreted"; seq: number; result: InterpretResult }
  | { type: "reply"; sessionId: string; text: string }
  | { type: "playbackEnded" }
  | { type: "confirm"; word: string }
  | { type: "pick"; session: VoiceSession }
  | { type: "sessions"; list: VoiceSession[]; blocked?: VoiceSession[] }
  | { type: "notice"; kind: string; sessionId: string }
  | { type: "interrupt" }
  /** Sleep from the drawer (the runner's off switch): same as "Jarvis, ignore me". */
  | { type: "sleep" };

export type VoiceEffect =
  | { type: "send"; session: VoiceSession; text: string; behavior: "steer" }
  | { type: "receipt"; session: VoiceSession; line: string }
  | { type: "speak"; line: string }
  | { type: "stopPlayback" }
  | { type: "askConfirm"; word: string; line: string }
  | { type: "listen" }
  | { type: "sleep" }
  | { type: "interpret"; seq: number; text: string }
  | { type: "interrupt"; session: VoiceSession };

export type VoiceStep = { state: VoiceState; effects: VoiceEffect[] };

/** How long a confirm waits for its word, on the Mac (the runner's timer) and the phone (Jarvis), before it is cancelled. */
export const CONFIRM_TIMEOUT_MS = 20_000;

/** Jarvis's provider id and the Voice helper's label: Voice's own sessions, never a target. */
export const ROUTER_PROVIDER_ID = "jarvis";
export const VOICE_HELPER_KIND = "voice-helper";

/** The confirm word that means "cancel" (button or the runner's timeout). */
export const CONFIRM_CANCEL = "cancel";

export function initialVoiceState(): VoiceState {
  return { mode: "asleep", session: null, sessions: [], blocked: [], talking: false, pending: null, confirm: null, held: null, queue: [], seq: 0 };
}

const NAMES = "jarvis|jervis|javis|travis|jarvus|service";
const NEVER_MIND = new Set(["never mind", "nevermind", "cancel that", "forget it", "belay that"]);
const CRITICAL = /\b(merge|interrupt|stop|delete)\b/;
// Confirm choices: "one" sends, "two" cancels (the word itself still sends; "to"/"too" are how "two" is often heard).
const CONFIRM_YES = new Set(["one", "1"]);
const CONFIRM_NO = new Set(["two", "2", "to", "too"]);
const NOTICE_ORDER: NoticeKind[] = ["finished", "needsYou", "error", "costCap"];
const NOTICE_ONE: Record<NoticeKind, string> = { finished: "finished", needsYou: "needs you", error: "hit an error", costCap: "hit the cost cap" };
const NOTICE_MANY: Record<NoticeKind, string> = { finished: "finished", needsYou: "need you", error: "hit an error", costCap: "hit the cost cap" };
const NUMBER_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
// Said after the name to wake the loop with nothing else to do.
const WAKE_WORDS = new Set(["", "wake up", "wake", "i m back", "im back", "listen", "you there", "are you there"]);

const norm = (text: string): string => text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const stripName = (text: string): string => text.replace(new RegExp(`^(?:(?:hey|ok|okay) )?(?:${NAMES})(?: |$)`), "").trim();
/** Asleep, only the name itself wakes the loop ("Jarvis", "hey Jarvis, …"), not a mishearing like "travis". */
const calledByName = (text: string): boolean => /^(?:(?:hey|ok|okay) )?jarvis(?: |$)/.test(norm(text));
const isBlocked = (state: VoiceState, id: string): boolean => state.blocked.some((s) => s.id === id);
/** True when the words start with the name (or a close mishearing), as in "Jarvis, wake up". */
export const addressed = (text: string): boolean => stripName(norm(text)) !== norm(text);
/** The words without a leading "Jarvis," (or "hey Jarvis"), punctuation and case kept. */
export const withoutName = (text: string): string =>
  text.replace(new RegExp(`^\\s*(?:(?:hey|ok|okay)[\\s,]+)?(?:${NAMES})\\b[\\s,.!?]*`, "i"), "").trim() || text.trim();
const critical = (text: string): string | null => CRITICAL.exec(text)?.[1] ?? null;
const out = (state: VoiceState, ...effects: VoiceEffect[]): VoiceStep => ({ state, effects });

function sentTo(state: VoiceState, text: string): VoiceStep {
  const session = state.session;
  if (!session) return out(state);
  if (isBlocked(state, session.id)) {
    return out({ ...state, session: null, pending: null, confirm: null }, { type: "speak", line: notTargetLine(session.name) });
  }
  const next = { ...state, mode: "waiting" as const, pending: null, confirm: null };
  return out(next, { type: "send", session, text, behavior: "steer" }, { type: "receipt", session, line: sentLine(session.name) });
}

function askConfirm(state: VoiceState, text: string, word: string): VoiceStep {
  const session = state.session;
  if (!session) return out(state);
  const next = { ...state, mode: "confirming" as const, pending: null, confirm: { word, text } };
  return out(next, { type: "askConfirm", word, line: confirmLine(text, session.name) });
}

function cancelled(state: VoiceState): VoiceStep {
  return out({ ...state, mode: "listening", pending: null, confirm: null }, { type: "speak", line: CANCELLED });
}

function sleep(state: VoiceState): VoiceStep {
  return out({ ...state, mode: "asleep", talking: false, pending: null, confirm: null, held: null, queue: [] }, { type: "sleep" });
}

function matching(sessions: VoiceSession[], spoken: string): VoiceSession[] {
  const query = norm(spoken);
  const exact = sessions.filter((s) => norm(s.name) === query);
  return exact.length ? exact : query ? sessions.filter((s) => norm(s.name).includes(query)) : [];
}

function switchTo(state: VoiceState, spoken: string): VoiceStep {
  const base = { ...state, pending: null, confirm: null };
  const matches = matching(state.sessions, spoken);
  const own = matches.length ? [] : matching(state.blocked, spoken);
  if (own.length) return out(base, { type: "speak", line: notTargetLine(own[0].name) });
  if (matches.length === 1) return out({ ...base, mode: "listening", session: matches[0] }, { type: "speak", line: switchedLine(matches[0].name) });
  if (matches.length > 1) {
    return out(base, { type: "speak", line: whichLine(matches.map((s) => s.name)) });
  }
  return out(base, { type: "speak", line: noSessionLine(spoken) });
}

function onUtterance(state: VoiceState, text: string): VoiceStep {
  const heard = norm(text);
  const cleaned = stripName(heard);
  const ignore = new RegExp(`^(?:(?:hey|ok|okay) )?(?:(${NAMES}) )?(?:ignor(?:e|ing)( me)?|(silent mode))$`).exec(heard);
  if (ignore && (ignore[1] || ignore[2] || ignore[3])) return sleep(state);
  if (NEVER_MIND.has(cleaned)) return state.confirm ? cancelled(state) : out({ ...state, pending: null });
  if (state.confirm) {
    if (CONFIRM_NO.has(cleaned)) return cancelled(state);
    return CONFIRM_YES.has(cleaned) || cleaned === state.confirm.word ? sentTo(state, state.confirm.text) : out(state);
  }
  // "One" with nothing waiting (it was cancelled or timed out) says so rather than nothing.
  if (CONFIRM_YES.has(cleaned)) return out({ ...state, pending: null }, { type: "speak", line: NOTHING_TO_CONFIRM });
  // Without the name, "switch to X" is only a switch when X is a session; otherwise it is a request for the session.
  const toName = /^switch to (.+)$/.exec(cleaned);
  if (toName && (cleaned !== heard || matching(state.sessions, toName[1]).length)) return switchTo(state, toName[1]);
  if (cleaned.split(" ").filter(Boolean).length < 2 && !critical(cleaned)) return out(state);
  if (!state.session) return out(state, { type: "speak", line: pickFirstLine(state.sessions.map((s) => s.name)) });
  const seq = state.seq + 1;
  return out({ ...state, seq, pending: { seq, heard: text } }, { type: "interpret", seq, text });
}

function onInterpreted(state: VoiceState, seq: number, result: InterpretResult): VoiceStep {
  const pending = state.pending;
  if (!pending || pending.seq !== seq || !state.session) return out(state);
  const base = { ...state, pending: null };
  if (result.type === "drop") return out(base);
  if (result.type === "switch") return switchTo(base, result.name);
  const word = critical(norm(result.text)) ?? critical(norm(pending.heard));
  if (result.type === "confirm") return askConfirm(base, result.text, word ?? "send");
  return word ? askConfirm(base, result.text, word) : sentTo(base, result.text);
}

function core(state: VoiceState, event: VoiceEvent): VoiceStep {
  if (event.type === "sessions") {
    const blocked = event.blocked ?? [];
    // A target that turns out to be one of Voice's own sessions is dropped.
    const session = state.session && blocked.some((s) => s.id === state.session?.id) ? null : state.session;
    return out({ ...state, sessions: event.list, blocked, session });
  }
  if (event.type === "pick" && isBlocked(state, event.session.id)) {
    return state.mode === "asleep" ? out(state) : out(state, { type: "speak", line: notTargetLine(event.session.name) });
  }
  if (state.mode === "asleep") {
    if (event.type === "wake") return out({ ...state, mode: "listening" }, { type: "listen" });
    if (event.type === "pick") return out({ ...state, session: event.session });
    // The name itself wakes it (only Jarvis hears while asleep: the drawer's mic is closed).
    if (event.type === "utterance" && calledByName(event.text)) {
      const awake: VoiceState = { ...state, mode: "listening" };
      const rest = norm(withoutName(event.text));
      if (!addressed(rest) && !WAKE_WORDS.has(rest)) {
        const r = onUtterance(awake, event.text);
        // "Jarvis, ignore me" while asleep just stays asleep.
        return r.state.mode === "asleep" ? out(state) : { state: r.state, effects: [{ type: "listen" }, ...r.effects] };
      }
      return out(awake, { type: "listen" }, { type: "speak", line: WAKE_LINE });
    }
    return out(state);
  }
  switch (event.type) {
    case "wake":
      return out(state);
    case "sleep": {
      const r = sleep(state);
      return state.mode === "speaking" ? { state: r.state, effects: [{ type: "stopPlayback" }, ...r.effects] } : r;
    }
    case "interrupt":
      return state.session ? out(state, { type: "interrupt", session: state.session }) : out(state);
    case "speechStart":
      return state.mode === "speaking" ? out({ ...state, mode: "listening", talking: true }, { type: "stopPlayback" }) : out({ ...state, talking: true });
    case "utterance": {
      const speaking = state.mode === "speaking";
      const r = onUtterance({ ...state, talking: false, mode: speaking ? "listening" : state.mode }, event.text);
      return speaking ? { state: r.state, effects: [{ type: "stopPlayback" }, ...r.effects] } : r;
    }
    case "interpreted":
      return onInterpreted(state, event.seq, event.result);
    case "reply": {
      if (event.sessionId !== state.session?.id) return out(state);
      const line = spokenLine(event.text);
      if (!line) return out(state);
      const spoken = `${state.session.name}: ${line}`;
      if (state.mode === "confirming" || state.talking) return out({ ...state, held: spoken });
      return out({ ...state, mode: "speaking", held: null }, { type: "speak", line: spoken });
    }
    case "playbackEnded":
      return state.mode === "speaking" ? out({ ...state, mode: "listening" }) : out(state);
    case "confirm":
      if (!state.confirm) return out(state);
      if (event.word === CONFIRM_CANCEL) return cancelled(state);
      return event.word === state.confirm.word ? sentTo(state, state.confirm.text) : out(state);
    case "pick":
      return out(
        { ...state, mode: "listening", session: event.session, pending: null, confirm: null, held: null },
        ...(state.mode === "speaking" ? [{ type: "stopPlayback" } as const] : []),
      );
    case "notice": {
      const kind = event.kind as NoticeKind;
      if (!NOTICE_ORDER.includes(kind) || (kind === "finished" && event.sessionId === state.session?.id)) return out(state);
      const name = state.sessions.find((s) => s.id === event.sessionId)?.name ?? "A session";
      return out({ ...state, queue: [...state.queue, { kind, sessionId: event.sessionId, name }] });
    }
  }
}

/** A held reply, else the queued notices as one line, go out once nothing else is talking, speaking or being confirmed. */
function flush(r: VoiceStep): VoiceStep {
  const { state, effects } = r;
  const idle = state.mode === "listening" || state.mode === "waiting";
  if (!idle || state.talking || effects.some((e) => e.type === "speak")) return r;
  if (state.held) return { state: { ...state, mode: "speaking", held: null }, effects: [...effects, { type: "speak", line: state.held }] };
  if (!state.queue.length) return r;
  return { state: { ...state, mode: "speaking", queue: [] }, effects: [...effects, { type: "speak", line: mergeNotices(state.queue) }] };
}

function mergeNotices(queue: Notice[]): string {
  const parts: string[] = [];
  for (const kind of NOTICE_ORDER) {
    const names = [...new Map(queue.filter((n) => n.kind === kind).map((n) => [n.sessionId, n.name])).values()];
    if (names.length === 1) parts.push(`${names[0]} ${NOTICE_ONE[kind]}`);
    else if (names.length > 1) parts.push(`${NUMBER_WORDS[names.length] ?? names.length} sessions ${NOTICE_MANY[kind]}`);
  }
  return parts.map((p, i) => (i === 0 ? p[0].toUpperCase() + p.slice(1) : p)).join(". ") + ".";
}

/** A session's spoken name: its title, else the first 8 characters of its id. */
export function sessionName(agent: { id: string; title?: string | null }): string {
  return agent.title?.trim() || agent.id.slice(0, 8);
}

type AgentLike = { id: string; title?: string | null; provider?: string; labels?: Record<string, string> | null };

/** False for Voice's own sessions: a Jarvis session or the Voice helper. */
export function canTarget(agent: { provider?: string; labels?: Record<string, string> | null }): boolean {
  return agent.provider !== ROUTER_PROVIDER_ID && agent.labels?.kind !== VOICE_HELPER_KIND;
}

/** The sessions Voice may send to; Voice's own sessions are left out. */
export function voiceSessions(agents: AgentLike[]): VoiceSession[] {
  return splitSessions(agents).list;
}

/** Sessions Voice may send to (`list`), and its own (`blocked`), for the loop's `sessions` event. */
export function splitSessions(agents: AgentLike[]): { list: VoiceSession[]; blocked: VoiceSession[] } {
  const named = (agent: AgentLike) => ({ id: agent.id, name: sessionName(agent) });
  return { list: agents.filter(canTarget).map(named), blocked: agents.filter((a) => !canTarget(a)).map(named) };
}

export function step(state: VoiceState, event: VoiceEvent): VoiceStep {
  return flush(core(state, event));
}
