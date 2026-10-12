// Every line Voice says or shows, in one place, so the Voice drawer (Mac) and Jarvis (phone) word things the
// same way. Pure: no imports, so any bundle can reach it.

const SPOKEN_CAP = 300;
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

/** d5: a reply as spoken: the first paragraph that isn't a code fence, markdown stripped, capped at 300 characters. */
export function spokenLine(text: string): string {
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
