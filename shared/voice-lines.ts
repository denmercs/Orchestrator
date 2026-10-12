// Every line Voice says or shows, in one place, so the Voice drawer (Mac) and Jarvis (phone) word things the
// same way. Pure: no imports, so any bundle can reach it.

const SPOKEN_CAP = 300;
const FULL_SPOKEN_CAP = 1500;
const LIST_MARKER = /^(?:[-*+]|\d+[.)])\s+/;
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** A choice number as said: "one" … "ten", then digits. */
export const numberWord = (n: number): string => NUMBER_WORDS[n] ?? String(n);
const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export const CANCELLED = "Cancelled.";
export const WAKE_LINE = "I'm listening.";
export const SLEEP_LINE = "Going quiet. Say Jarvis to wake me.";
export const ASLEEP_NOTE = "Jarvis is asleep. Say Jarvis to wake it.";
export const NOTHING_SENT = "Nothing sent.";
export const NOTHING_TO_CONFIRM = "Nothing to confirm.";
export const STOPPED_NOTE = "Stopped before sending.";

export const sentLine = (name: string) => `Sent to ${name}.`;
export const switchedLine = (name: string) => `Now on ${name}.`;
/** No session by that name; with names, the numbered list follows so a number can answer it. */
export const noSessionLine = (spoken: string, names: string[] = [], total = names.length) =>
  names.length ? `No session called ${spoken}. ${listLine(names, total)}` : `No session called ${spoken}.`;
export const sendFailedLine = (name: string, error: string) => `Couldn't send to ${name}: ${error}`;
/** How to answer a confirm; said again when the answer was anything else. */
export const CONFIRM_AGAIN = "Say one to send, or two to cancel.";
export const confirmLine = (text: string, name: string) => `Send "${text}" to ${name}? ${CONFIRM_AGAIN}`;

/** A Jarvis session or the Voice helper: sending to it would talk to itself. */
export const notTargetLine = (name: string) => `${name} is a voice session, so it can't be the target. Pick another session.`;

/** After a numbered list or question: how to answer it. */
export const SAY_A_NUMBER = "Say a number, or switch to and a name.";
export const NO_SESSIONS = "No sessions are open.";

/** Numbered session names, as read for "list sessions": "One, Check. Two, S4 Plan. … Say a number…". */
export function listLine(names: string[], total = names.length): string {
  if (!names.length) return NO_SESSIONS;
  const items = names.map((name, i) => `${capital(numberWord(i + 1))}, ${name}.`).join(" ");
  return `${items}${total > names.length ? " And more." : ""} ${SAY_A_NUMBER}`;
}

/** Several sessions fit the name: numbered, so "one" or "two" picks. */
export function whichLine(names: string[]): string {
  return `Did you mean: ${names.map((name, i) => `${numberWord(i + 1)}, ${name}`).join("; ")}? Say a number.`;
}

/** A number past the end of the last numbered list. */
export const noChoiceLine = (n: number, count: number) => `There's no number ${numberWord(n)}. Say a number from one to ${numberWord(count)}.`;

/** Said with no target: how to pick one, with the first few sessions numbered. */
export function pickFirstLine(names: string[], total = names.length): string {
  return `Pick a session first. ${listLine(names, total)}`;
}

/** d5: a reply as spoken: the first paragraph that isn't a code fence, markdown stripped, capped at 300 characters.
 *  Full: every paragraph, minus code fences and table rows, list markers dropped, capped at 1500 characters. */
export function spokenLine(text: string, full = false): string {
  const paragraphs: string[][] = [[]];
  let fenced = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (full && line.startsWith("|")) continue;
    if (!line) paragraphs.push([]);
    else if (full && LIST_MARKER.test(line)) paragraphs.push([line.replace(LIST_MARKER, "")]);
    else paragraphs[paragraphs.length - 1].push(line);
  }
  const plains = paragraphs.map((lines) => plainText(lines.join(" "))).filter(Boolean);
  if (!full) return plains[0] ? cap(plains[0], SPOKEN_CAP) : "";
  // A heading or list item has no full stop; add one so the voice pauses instead of running on.
  return cap(plains.map((plain) => (/[.!?:]$/.test(plain) ? plain : `${plain}.`)).join(" "), FULL_SPOKEN_CAP);
}

function plainText(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/[^\s()]+/g, fileNameOnly)
    .replace(/[^\s()]+/g, dropCommitHash)
    .replace(/\s*\(\s*\)/g, "")
    .replace(/(^|\s)#+\s+/g, "$1")
    .replace(/\*+/g, "")
    .replace(/(^|[\s(])_+([^_]+?)_+(?=$|[\s).,;:!?])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** A file path as said: just the file name ("src/app/a.ts:12" → "a.ts"). URLs, dates and "and/or" are left alone. */
function fileNameOnly(token: string): string {
  const [, core, tail] = /^(.*?)([.,;:!?]*)$/.exec(token) ?? [, token, ""];
  if (!core.includes("/") || core.includes("://") || /^[\d/]+$/.test(core)) return token;
  const parts = core.split("/").filter(Boolean);
  const last = parts[parts.length - 1]?.replace(/:\d+(?::\d+)?$/, "");
  const anchored = /^(?:~|\.{1,2})?\//.test(core) || /^\.{1,2}\//.test(core);
  if (!last || !(anchored || parts.length > 2 || /\.\w+$/.test(last))) return token;
  return `${last}${tail}`;
}

/** A commit hash is noise read aloud, so it is dropped ("at f2a6468." → "at."); a plain number or word is kept. */
function dropCommitHash(token: string): string {
  const [, core, tail] = /^(.*?)([.,;:!?]*)$/.exec(token) ?? [, token, ""];
  return /^[0-9a-f]{7,40}$/.test(core) && /\d/.test(core) && /[a-f]/.test(core) ? tail : token;
}

function cap(line: string, limit: number): string {
  if (line.length <= limit) return line;
  const cut = line.slice(0, limit);
  const ends = [...cut.matchAll(/[.!?](?=\s)/g)];
  if (ends.length) return cut.slice(0, ends[ends.length - 1].index + 1);
  const space = cut.lastIndexOf(" ");
  return `${space > 0 ? cut.slice(0, space) : cut}…`;
}
