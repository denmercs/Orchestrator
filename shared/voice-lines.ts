// Every line Voice says or shows, in one place, so the Voice drawer (Mac) and Jarvis (phone) word things the
// same way. Pure: no imports, so any bundle can reach it.

/** How many session names a line lists before "and more". */
const NAMES_SHOWN = 5;
const SPOKEN_CAP = 300;

export const CANCELLED = "Cancelled.";
export const WAKE_LINE = "I'm listening.";
export const SLEEP_LINE = "Going quiet. Say Jarvis to wake me.";
export const ASLEEP_NOTE = "Jarvis is asleep. Say Jarvis to wake it.";
export const NOTHING_SENT = "Nothing sent.";

export const sentLine = (name: string) => `Sent to ${name}.`;
export const switchedLine = (name: string) => `Now on ${name}.`;
export const noSessionLine = (spoken: string) => `No session called ${spoken}.`;
export const sendFailedLine = (name: string, error: string) => `Couldn't send to ${name}: ${error}`;
export const confirmLine = (text: string, name: string) => `Send "${text}" to ${name}? Say one to send, or two to cancel.`;

export function whichLine(names: string[]): string {
  return `Which one: ${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}?`;
}

/** Said with no target: how to pick one, and the first few session names. */
export function pickFirstLine(names: string[]): string {
  const known = names.length
    ? `Sessions: ${names.slice(0, NAMES_SHOWN).join(", ")}${names.length > NAMES_SHOWN ? ", and more" : ""}.`
    : "No sessions are open.";
  return `Pick a session first: say switch to, then a name. ${known}`;
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
