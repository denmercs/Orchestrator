// The Voice loop: a pure state machine that decides everything the Jarvis panel does.
// step(state, event) → { state, effects }. Adapters (mic, transcriber, interpreter, session link, speaker) only carry
// events in and effects out; the loop holds no clocks and imports only its own wording (voice-lines) and name
// matching (voice-names), so any bundle can reach it. The Voice runner (Jarvis panel, Mac) and the Jarvis router (phone) both run it.
import { CANCELLED, CONFIRM_AGAIN, confirmLine, listLine, newSessionLine, noChoiceLine, noSessionLine, notTargetLine, NOTHING_TO_CONFIRM, pickFirstLine, replyLine, spokenLine, switchedLine, WAKE_LINE, whichLine } from "./voice-lines";
import { choiceNumber, exactSessions, matchSessions, shortName } from "./voice-names";

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
  /** The sessions of the last numbered list or question, so a bare number ("two", "number two") picks one. */
  choices: VoiceSession[] | null;
  /** A request waiting on that list (from the helper's `sendTo`): the pick switches, then sends it. Ignored when `choices` is null. */
  choicesText?: string;
  /** The target's spoken reply, held while you talk or confirm. */
  held: string | null;
  queue: Notice[];
  /** Replies of sessions you asked to hear (the Speak pill), as spoken lines, waiting their turn like the notices. */
  heard: { sessionId: string; line: string }[];
  seq: number;
};

/** What the interpreter helper (d1) made of an utterance. */
export type InterpretResult = { type: "send"; text: string } | { type: "switch"; name: string }
  /** A loose request for a named session ("send that to the planning one"): the loop matches the name, then sends the text. */
  | { type: "sendTo"; session: string; text: string }
  | { type: "drop" };

export type VoiceEvent =
  | { type: "wake" }
  /** Every speechStart is followed by an utterance, empty when nothing was heard, so `talking` always ends. */
  | { type: "speechStart" }
  /** `typed`: from the keyboard, so the short-text and helper filters are skipped and it always goes to the target. */
  | { type: "utterance"; text: string; typed?: boolean }
  /** Paseo voice mode heard this on the phone or laptop (not typed, not muted). The drawer shows it as a "you" line; the loop ignores it. */
  | { type: "heard"; text: string }
  | { type: "interpreted"; seq: number; result: InterpretResult }
  /** `watched`: the session is on the Speak pill, so its reply is heard even when it is not the target. */
  | { type: "reply"; sessionId: string; text: string; summary?: string; watched?: boolean }
  | { type: "playbackEnded" }
  | { type: "confirm"; word: string }
  | { type: "pick"; session: VoiceSession }
  | { type: "sessions"; list: VoiceSession[]; blocked?: VoiceSession[] }
  /** A numbered list unanswered for `CONFIRM_TIMEOUT_MS` (the runner's timer, or Jarvis on the next words) is forgotten. */
  | { type: "choicesExpired" }
  | { type: "notice"; kind: string; sessionId: string }
  | { type: "interrupt" }
  /** Sleep from the drawer (the runner's off switch): same as "Jarvis, ignore me". */
  | { type: "sleep" };

export type VoiceEffect =
  | { type: "send"; session: VoiceSession; text: string; behavior: "steer" }
  | { type: "speak"; line: string }
  | { type: "stopPlayback" }
  | { type: "askConfirm"; word: string; line: string }
  | { type: "listen" }
  | { type: "sleep" }
  | { type: "interpret"; seq: number; text: string }
  | { type: "interrupt"; session: VoiceSession }
  /** Start a new voice session in `session`'s workspace (the target when it was asked for). */
  | { type: "create"; session: VoiceSession };

export type VoiceStep = { state: VoiceState; effects: VoiceEffect[] };

/** How long a confirm waits for its word, and a numbered list for its number, on the Mac (the runner's timer) and the phone (Jarvis), before it is dropped. */
export const CONFIRM_TIMEOUT_MS = 20_000;

/** Jarvis's provider id and the Voice helper's label: Voice's own sessions, never a target. */
export const ROUTER_PROVIDER_ID = "jarvis";
export const VOICE_HELPER_KIND = "voice-helper";

/** The confirm word that means "cancel" (button or the runner's timeout). */
export const CONFIRM_CANCEL = "cancel";

export function initialVoiceState(): VoiceState {
  return { mode: "asleep", session: null, sessions: [], blocked: [], talking: false, pending: null, confirm: null, choices: null, held: null, queue: [], heard: [], seq: 0 };
}

const NAMES = "jarvis|jervis|javis|travis|jarvus|service";
const NEVER_MIND = new Set(["never mind", "nevermind", "cancel that", "forget it", "belay that"]);
// A confirm is answered only by these exact words (or the critical word said back); anything else asks again.
// "to"/"too" are how "two" is often heard: cancelling on a mishearing is safe, sending on one is not.
const CONFIRM_YES = new Set(["one", "1", "number one", "number 1"]);
const CONFIRM_NO = new Set(["two", "2", "number two", "number 2", "to", "too"]);
// Numbered lists: "list sessions" reads up to six; "Pick a session first" up to four.
const LIST_SHOWN = 6;
const PICK_SHOWN = 4;
const LIST_SESSIONS = /^(?:(?:list|show|read|which|what)(?: me)?(?: the| all| my)? sessions?(?: (?:are )?(?:there|open|running))?|sessions)$/;
// "switch to X" (and "go/talk/change/move to X"), or "use/pick/open/choose/select X".
const SWITCH_TO = /^(?:(switch|go|talk|change|move) to|(use|pick|open|choose|select)) (.+)$/;
const NEW_SESSION = /^(?:start |create |open )?(?:a )?new (?:voice )?session$/;
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
const out = (state: VoiceState, ...effects: VoiceEffect[]): VoiceStep => ({ state, effects });

function sentTo(state: VoiceState, text: string): VoiceStep {
  const session = state.session;
  if (!session) return out(state);
  if (isBlocked(state, session.id)) {
    return out({ ...state, session: null, pending: null, confirm: null }, { type: "speak", line: notTargetLine(shortName(session.name)) });
  }
  const next = { ...state, mode: "waiting" as const, pending: null, confirm: null };
  return out(next, { type: "send", session, text, behavior: "steer" });
}

function askConfirm(state: VoiceState, text: string, word: string): VoiceStep {
  const session = state.session;
  if (!session) return out(state);
  const next = { ...state, mode: "confirming" as const, pending: null, choices: null, confirm: { word, text } };
  return out(next, { type: "askConfirm", word, line: confirmLine(text, shortName(session.name)) });
}

function cancelled(state: VoiceState): VoiceStep {
  return out({ ...state, mode: "listening", pending: null, confirm: null }, { type: "speak", line: CANCELLED });
}

function sleep(state: VoiceState): VoiceStep {
  return out({ ...state, mode: "asleep", talking: false, pending: null, confirm: null, choices: null, held: null, queue: [], heard: [] }, { type: "sleep" });
}

const short = (sessions: VoiceSession[]): string[] => sessions.map((s) => shortName(s.name));

function switched(state: VoiceState, session: VoiceSession): VoiceStep {
  const next = { ...state, mode: "listening" as const, session, pending: null, confirm: null, choices: null };
  return out(next, { type: "speak", line: switchedLine(shortName(session.name)) });
}

/** Asks which of several sessions, numbered; a bare number then answers it. */
function askWhich(state: VoiceState, matches: VoiceSession[], text?: string): VoiceStep {
  const choices = matches.slice(0, LIST_SHOWN);
  return out({ ...state, choices, choicesText: text }, { type: "speak", line: whichLine(short(choices)) });
}

/** Reads a numbered list of sessions through `line`, and remembers it for a bare number. */
function numberedList(state: VoiceState, shown: number, line: (names: string[], total: number) => string, text?: string): VoiceStep {
  const choices = state.sessions.slice(0, shown);
  return out({ ...state, choices: choices.length ? choices : null, choicesText: text }, { type: "speak", line: line(short(choices), state.sessions.length) });
}

function switchTo(state: VoiceState, spoken: string, text?: string): VoiceStep {
  const base = { ...state, pending: null, confirm: null, choices: null };
  const matches = matchSessions(state.sessions, spoken);
  const own = matches.length ? [] : matchSessions(state.blocked, spoken, false);
  if (own.length) return out(base, { type: "speak", line: notTargetLine(shortName(own[0].name)) });
  if (matches.length === 1) return switched(base, matches[0]);
  if (matches.length > 1) return askWhich(base, matches, text);
  return numberedList(base, PICK_SHOWN, (names, total) => noSessionLine(spoken, names, total), text);
}

/** A bare number after a numbered list or question picks that entry. */
function pickNumber(state: VoiceState, choices: VoiceSession[], n: number): VoiceStep {
  const session = choices[n - 1];
  if (!session) return out({ ...state, pending: null }, { type: "speak", line: noChoiceLine(n, choices.length) });
  if (isBlocked(state, session.id)) return out({ ...state, pending: null, choices: null }, { type: "speak", line: notTargetLine(shortName(session.name)) });
  const picked = switched(state, session);
  const text = state.choicesText;
  if (text === undefined) return picked;
  // A list that carried a request: the pick makes the session the target, then the text goes the normal send path.
  return sentTo({ ...picked.state, choicesText: undefined }, text);
}

function onUtterance(state: VoiceState, text: string, typed = false): VoiceStep {
  const heard = norm(text);
  const cleaned = stripName(heard);
  const ignore = new RegExp(`^(?:(?:hey|ok|okay) )?(?:(${NAMES}) )?(?:ignor(?:e|ing)( me)?|(silent mode))$`).exec(heard);
  if (ignore && (ignore[1] || ignore[2] || ignore[3])) return sleep(state);
  if (NEVER_MIND.has(cleaned)) return state.confirm ? cancelled(state) : out({ ...state, pending: null, choices: null });
  // A pending confirm is the latest numbered question, and only an exact answer settles it.
  if (state.confirm) {
    if (CONFIRM_NO.has(cleaned)) return cancelled(state);
    if (CONFIRM_YES.has(cleaned) || cleaned === state.confirm.word) return sentTo(state, state.confirm.text);
    return out(state, { type: "speak", line: CONFIRM_AGAIN });
  }
  // A list is answered by the next words or not at all: anything that isn't a number forgets it.
  const number = state.choices ? choiceNumber(cleaned) : null;
  if (state.choices && number !== null) return pickNumber(state, state.choices, number);
  const base = { ...state, choices: null };
  // A bare "one" with nothing waiting (cancelled or timed out) says so; anything longer is speech for the target.
  if (cleaned === "one" || cleaned === "1") return out({ ...base, pending: null }, { type: "speak", line: NOTHING_TO_CONFIRM });
  if (LIST_SESSIONS.test(cleaned)) return numberedList({ ...base, pending: null }, LIST_SHOWN, listLine);
  if (NEW_SESSION.test(cleaned)) {
    const target = state.session;
    if (!target) return numberedList({ ...base, pending: null }, PICK_SHOWN, pickFirstLine);
    return out({ ...base, pending: null }, { type: "create", session: target }, { type: "speak", line: newSessionLine(shortName(target.name)) });
  }
  // Without the name and with a target, "switch to X" is only a switch when X is a session (and "use X", "open X"
  // only when X is exactly one); otherwise it is a request for the session.
  const toName = SWITCH_TO.exec(cleaned);
  if (toName) {
    const name = toName[3];
    const sure = toName[1] === "switch" ? matchSessions(state.sessions, name, false) : exactSessions(state.sessions, name);
    if (cleaned !== heard || !state.session || sure.length) return switchTo(base, name);
  }
  // With no target yet, a session's name on its own switches to it.
  if (!state.session) {
    const named = exactSessions(state.sessions, cleaned);
    if (named.length === 1) return switched(base, named[0]);
    if (named.length > 1) return askWhich({ ...base, pending: null }, named);
  }
  if (!typed && cleaned.split(" ").filter(Boolean).length < 2) return out(base);
  if (!state.session) return numberedList({ ...base, pending: null }, PICK_SHOWN, pickFirstLine);
  if (typed) return sentTo(base, text.trim());
  const seq = state.seq + 1;
  return out({ ...base, seq, pending: { seq, heard: text } }, { type: "interpret", seq, text });
}

function onInterpreted(state: VoiceState, seq: number, result: InterpretResult): VoiceStep {
  const pending = state.pending;
  if (!pending || pending.seq !== seq || !state.session) return out(state);
  const base = { ...state, pending: null };
  if (result.type === "drop") return out(base);
  if (result.type === "switch") return switchTo(base, result.name);
  if (result.type === "sendTo") {
    const matches = matchSessions(state.sessions, result.session);
    // One match: it becomes the target and the text is sent. Several or none: the numbered list, carrying the text. One of Voice's own: said so.
    if (matches.length !== 1) return switchTo(base, result.session, result.text);
    return sentTo({ ...base, session: matches[0], choices: null }, result.text);
  }
  return sentTo(base, result.text);
}

function core(state: VoiceState, event: VoiceEvent): VoiceStep {
  // Display only: the drawer shows it, the loop never acts on it.
  if (event.type === "heard") return out(state);
  if (event.type === "sessions") {
    const blocked = event.blocked ?? [];
    // A target that turns out to be one of Voice's own sessions is dropped.
    const session = state.session && blocked.some((s) => s.id === state.session?.id) ? null : state.session;
    // A numbered list that lost a session is forgotten rather than renumbered under you.
    const choices = state.choices?.every((c) => event.list.some((s) => s.id === c.id)) ? state.choices : null;
    return out({ ...state, sessions: event.list, blocked, session, choices });
  }
  if (event.type === "choicesExpired") return out({ ...state, choices: null });
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
      const r = onUtterance({ ...state, talking: false, mode: speaking ? "listening" : state.mode }, event.text, event.typed);
      return speaking ? { state: r.state, effects: [{ type: "stopPlayback" }, ...r.effects] } : r;
    }
    case "interpreted":
      return onInterpreted(state, event.seq, event.result);
    case "reply": {
      if (event.sessionId !== state.session?.id) {
        const line = event.watched ? replyLine(event.text, event.summary) : "";
        if (!line) return out(state);
        const name = shortName(state.sessions.find((s) => s.id === event.sessionId)?.name ?? "A session");
        return out({ ...state, heard: [...state.heard, { sessionId: event.sessionId, line: `${name}: ${line}` }] });
      }
      const line = replyLine(event.text, event.summary);
      if (!line) return out(state);
      const spoken = `${shortName(state.session.name)}: ${line}`;
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
        { ...state, mode: "listening", session: event.session, pending: null, confirm: null, choices: null, held: null },
        ...(state.mode === "speaking" ? [{ type: "stopPlayback" } as const] : []),
      );
    case "notice": {
      const kind = event.kind as NoticeKind;
      if (!NOTICE_ORDER.includes(kind) || (kind === "finished" && event.sessionId === state.session?.id)) return out(state);
      const found = state.sessions.find((s) => s.id === event.sessionId);
      const name = found ? shortName(found.name) : "A session";
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
  if (!state.queue.length && !state.heard.length) return r;
  const line = [...state.heard.map((h) => h.line), ...(state.queue.length ? [mergeNotices(state.queue)] : [])].join(" ");
  return { state: { ...state, mode: "speaking", queue: [], heard: [] }, effects: [...effects, { type: "speak", line }] };
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
