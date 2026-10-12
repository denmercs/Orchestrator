// The Voice loop: a pure state machine that decides everything the Voice drawer does.
// step(state, event) → { state, effects }. Adapters (mic, transcriber, interpreter, session link, speaker) only carry
// events in and effects out; the loop holds no clocks and imports nothing, so any bundle can reach it.

export type VoiceMode = "asleep" | "listening" | "confirming" | "waiting" | "speaking";
export type VoiceSession = { id: string; name: string };
export type NoticeKind = "finished" | "needsYou" | "error" | "costCap";
export type Notice = { kind: NoticeKind; sessionId: string; name: string };

export type VoiceState = {
  mode: VoiceMode;
  session: VoiceSession | null;
  sessions: VoiceSession[];
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
  | { type: "sessions"; list: VoiceSession[] }
  | { type: "notice"; kind: string; sessionId: string }
  | { type: "interrupt" };

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

/** The confirm word that means "cancel" (button or the runner's timeout). */
export const CONFIRM_CANCEL = "cancel";

export function initialVoiceState(): VoiceState {
  return { mode: "asleep", session: null, sessions: [], talking: false, pending: null, confirm: null, held: null, queue: [], seq: 0 };
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
const SPOKEN_CAP = 300;

const norm = (text: string): string => text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const stripName = (text: string): string => text.replace(new RegExp(`^(?:(?:hey|ok|okay) )?(?:${NAMES})(?: |$)`), "").trim();
const critical = (text: string): string | null => CRITICAL.exec(text)?.[1] ?? null;
const out = (state: VoiceState, ...effects: VoiceEffect[]): VoiceStep => ({ state, effects });

function sentTo(state: VoiceState, text: string): VoiceStep {
  const session = state.session;
  if (!session) return out(state);
  const next = { ...state, mode: "waiting" as const, pending: null, confirm: null };
  return out(next, { type: "send", session, text, behavior: "steer" }, { type: "receipt", session, line: `Sent to ${session.name}` });
}

function askConfirm(state: VoiceState, text: string, word: string): VoiceStep {
  const session = state.session;
  if (!session) return out(state);
  const next = { ...state, mode: "confirming" as const, pending: null, confirm: { word, text } };
  return out(next, { type: "askConfirm", word, line: `Send "${text}" to ${session.name}? Say one to send, or two to cancel.` });
}

function cancelled(state: VoiceState): VoiceStep {
  return out({ ...state, mode: "listening", pending: null, confirm: null }, { type: "speak", line: "Cancelled." });
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
  if (matches.length === 1) return out({ ...base, mode: "listening", session: matches[0] }, { type: "speak", line: `Now on ${matches[0].name}.` });
  if (matches.length > 1) {
    const names = matches.map((s) => s.name);
    return out(base, { type: "speak", line: `Which one: ${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}?` });
  }
  return out(base, { type: "speak", line: `No session called ${spoken}.` });
}

function onUtterance(state: VoiceState, text: string): VoiceStep {
  const heard = norm(text);
  const cleaned = stripName(heard);
  const ignore = new RegExp(`^(?:(?:hey|ok|okay) )?(?:(${NAMES}) )?ignor(?:e|ing)( me)?$`).exec(heard);
  if (ignore && (ignore[1] || ignore[2])) return sleep(state);
  if (NEVER_MIND.has(cleaned)) return state.confirm ? cancelled(state) : out({ ...state, pending: null });
  if (state.confirm) {
    if (CONFIRM_NO.has(cleaned)) return cancelled(state);
    return CONFIRM_YES.has(cleaned) || cleaned === state.confirm.word ? sentTo(state, state.confirm.text) : out(state);
  }
  // Without the name, "switch to X" is only a switch when X is a session; otherwise it is a request for the session.
  const toName = /^switch to (.+)$/.exec(cleaned);
  if (toName && (cleaned !== heard || matching(state.sessions, toName[1]).length)) return switchTo(state, toName[1]);
  if (cleaned.split(" ").filter(Boolean).length < 2 && !critical(cleaned)) return out(state);
  if (!state.session) return out(state, { type: "speak", line: "Pick a session first." });
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
  if (event.type === "sessions") return out({ ...state, sessions: event.list });
  if (state.mode === "asleep") {
    if (event.type === "wake") return out({ ...state, mode: "listening" }, { type: "listen" });
    if (event.type === "pick") return out({ ...state, session: event.session });
    return out(state);
  }
  switch (event.type) {
    case "wake":
      return out(state);
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

/** d5: the first paragraph that isn't a code fence, markdown stripped, capped at 300 characters. */
function spokenLine(text: string): string {
  const paragraphs: string[][] = [[]];
  let fenced = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (!line) paragraphs.push([]);
    else paragraphs[paragraphs.length - 1].push(line);
  }
  for (const lines of paragraphs) {
    const plain = lines
      .join(" ")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`/g, "")
      .replace(/(^|\s)#+\s+/g, "$1")
      .replace(/\*+/g, "")
      .replace(/(^|[\s(])_+([^_]+?)_+(?=$|[\s).,;:!?])/g, "$1$2")
      .replace(/\s+/g, " ")
      .trim();
    if (plain) return cap(plain);
  }
  return "";
}

function cap(line: string): string {
  if (line.length <= SPOKEN_CAP) return line;
  const cut = line.slice(0, SPOKEN_CAP);
  const ends = [...cut.matchAll(/[.!?](?=\s)/g)];
  if (ends.length) return cut.slice(0, ends[ends.length - 1].index + 1);
  const space = cut.lastIndexOf(" ");
  return `${space > 0 ? cut.slice(0, space) : cut}…`;
}

export function step(state: VoiceState, event: VoiceEvent): VoiceStep {
  return flush(core(state, event));
}
