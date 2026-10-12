// Every line Voice says or shows, in one place, so the Voice drawer (Mac) and Jarvis (phone) word things the
// same way. Pure: no imports, so any bundle can reach it.

const SPOKEN_CAP = 300;
const FULL_SPOKEN_CAP = 1500;
const MEDIUM_SPOKEN_CAP = 700;
const LIST_KEPT = 3;
const NEEDS_YOU = /\?|\bsay (?:one|two|three|merge|yes|skip)\b|\b(?:blocked|denied|failed|failing|error|errors|needs? you|conflicts?)\b/i;
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

export type SpokenLevel = "short" | "medium" | "full";

/** d5: a reply as spoken: the first paragraph that isn't a code fence, markdown stripped, capped at 300 characters.
 *  Full: every paragraph, minus code fences and table rows, list markers dropped, capped at 1500 characters.
 *  Medium: full, squeezed (test counts, long lists, file types, branch names, timings), kept to about 700 characters
 *  with any question, choice or blocker always kept. */
export function spokenLine(text: string, level: SpokenLevel = "short"): string {
  const full = level !== "short";
  const medium = level === "medium";
  const paragraphs: string[][] = [[]];
  let fenced = false;
  let run = 0; // list items in the current run, so a long list is cut to a few
  let skipped = 0;
  const endRun = () => {
    if (skipped) paragraphs.push([`And ${numberWord(skipped)} more.`]);
    run = skipped = 0;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (full && line.startsWith("|")) continue;
    if (!line) {
      endRun();
      paragraphs.push([]);
    } else if (full && LIST_MARKER.test(line)) {
      run++;
      if (medium && run > LIST_KEPT) skipped++;
      else paragraphs.push([line.replace(LIST_MARKER, "")]);
    } else {
      endRun();
      paragraphs[paragraphs.length - 1].push(line);
    }
  }
  endRun();
  const plains = paragraphs.map((lines) => plainText(lines.join(" "), medium)).filter(Boolean);
  if (!full) return plains[0] ? cap(plains[0], SPOKEN_CAP) : "";
  // A heading or list item has no full stop; add one so the voice pauses instead of running on.
  const sentences = plains.map((plain) => (/[.!?:]$/.test(plain) ? plain : `${plain}.`));
  return cap((medium ? squeeze(sentences) : sentences).join(" "), FULL_SPOKEN_CAP);
}

/** Medium: keep every paragraph that asks, offers a choice or reports a blocker, then fill what is left of the budget
 *  with the rest from the top, so the gist comes first and what needs the listener is never cut. */
function squeeze(sentences: string[]): string[] {
  const keep = new Set(sentences.flatMap((sentence, i) => (NEEDS_YOU.test(sentence) ? [i] : [])));
  let used = [...keep].reduce((sum, i) => sum + sentences[i].length + 1, 0);
  let filled = false;
  for (let i = 0; i < sentences.length; i++) {
    if (keep.has(i)) continue;
    const room = MEDIUM_SPOKEN_CAP - used;
    if (sentences[i].length + 1 <= room) {
      keep.add(i);
      used += sentences[i].length + 1;
    } else {
      // Nothing fit yet: a long opening still gets said, cut on a sentence end.
      if (!filled && room > 0) keep.add(i), (sentences = sentences.map((sentence, j) => (j === i ? cap(sentence, room) : sentence)));
      break;
    }
    filled = true;
  }
  return sentences.filter((_, i) => keep.has(i));
}

function plainText(text: string, medium = false): string {
  const plain = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/[^\s()]+/g, linkOnly)
    .replace(/[^\s()]+/g, fileNameOnly)
    .replace(/[^\s()]+/g, dropCommitHash)
    .replace(/\s*\(\s*\)/g, "")
    .replace(/(^|\s)#+\s+/g, "$1")
    .replace(/\*+/g, "")
    .replace(/(^|[\s(])_+([^_]+?)_+(?=$|[\s).,;:!?])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  return medium ? mediumText(plain) : plain;
}

const COUNT = "(\\d[\\d,]*)";
const WORD = "[\\w@-][\\w.@-]*";

/** Medium's squeeze of one paragraph: test counts, branch names, long timings, and runs of same-type files. */
function mediumText(text: string): string {
  return text
    .replace(new RegExp(`\\b${COUNT}\\s+(?:tests?\\s+)?pass(?:ed|ing)?(?:,|\\s+and)?\\s+${COUNT}\\s+(?:tests?\\s+)?(?:fail(?:ed|ing|ures?)?)`, "gi"), (_, _pass, fails) =>
      Number(fails.replace(/,/g, "")) === 0 ? "all tests passing" : `${fails} tests failing`)
    .replace(new RegExp(`\\b${COUNT}\\s+tests?\\s+pass(?:ed|ing)?\\b`, "gi"), "all tests passing")
    .replace(/\b(?:feature|fix|hotfix|chore|release|dm)\/[\w./-]*[\w/-]/g, "the branch")
    .replace(/\b(\d{4,})(?:\.\d+)?\s?ms\b/g, (_, ms) => `about ${numberWord(Math.round(Number(ms) / 1000))} ${Math.round(Number(ms) / 1000) === 1 ? "second" : "seconds"}`)
    .replace(new RegExp(`${WORD}\\.(\\w{1,5})(?:(?:,\\s*(?:and\\s+)?|\\s+and\\s+)${WORD}\\.\\1\\b){2,}`, "g"), (match, ext) => {
      const count = match.split(new RegExp(`\\.${ext}\\b`)).length - 1;
      return `${numberWord(count)} ${ext} files`;
    });
}

/** A URL as said: "a link", or "PR 137" for a GitHub pull request. */
function linkOnly(token: string): string {
  const [, core, tail] = /^(.*?)([.,;:!?]*)$/.exec(token) ?? [, token, ""];
  if (!/^https?:\/\//.test(core)) return token;
  const pull = /github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/.exec(core);
  return `${pull ? `PR ${pull[1]}` : "a link"}${tail}`;
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

/** A commit hash or UUID is noise read aloud, so it is dropped ("at f2a6468." → "at."); a plain number or word is kept. */
function dropCommitHash(token: string): string {
  const [, core, tail] = /^(.*?)([.,;:!?]*)$/.exec(token) ?? [, token, ""];
  const hash = /^[0-9a-f]{7,40}$/.test(core) && /\d/.test(core) && /[a-f]/.test(core);
  return hash || /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(core) ? tail : token;
}

function cap(line: string, limit: number): string {
  if (line.length <= limit) return line;
  const cut = line.slice(0, limit);
  const ends = [...cut.matchAll(/[.!?](?=\s)/g)];
  if (ends.length) return cut.slice(0, ends[ends.length - 1].index + 1);
  const space = cut.lastIndexOf(" ");
  return `${space > 0 ? cut.slice(0, space) : cut}…`;
}
