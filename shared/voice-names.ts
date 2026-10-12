// Session names as Voice says and hears them: a short name to speak, loose matching of what the transcriber
// heard against session titles, and spoken numbers for numbered choices. Deterministic, no model. Pure: no
// imports, so any bundle can reach it. Used by the Voice loop, so the drawer (Mac) and Jarvis (phone) match alike.

const CARDINALS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const ORDINALS = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const FILLER = new Set(["the", "a", "an", "session", "please"]);
const SHORT_WORDS = 6;

/** A title as said aloud: emoji and symbols gone, cut at a " — " or " - " separator, " · " as a space, at most six words. */
export function shortName(name: string): string {
  const head = name.split(/\s+[—–-]\s+/)[0];
  const plain = head
    .replace(/[^\p{L}\p{N}\s'._-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[._-]+$/, "");
  const words = plain.split(" ");
  return (words.length > SHORT_WORDS ? words.slice(0, SHORT_WORDS).join(" ") : plain) || name.trim();
}

const numberish = (word: string): string => {
  const cardinal = CARDINALS.indexOf(word);
  if (cardinal >= 0) return String(cardinal);
  const ordinal = ORDINALS.indexOf(word);
  return ordinal > 0 ? String(ordinal) : word;
};

/** Lowercase words, symbols dropped, number words as digits ("one", "first" → "1"), filler words left out. */
export function nameTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(numberish)
    .filter((w) => !FILLER.has(w));
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/** Same word, or one slip apart when both are four letters or more ("architecure", "phaze"). */
const close = (a: string, b: string): boolean => a === b || (a.length >= 4 && b.length >= 4 && editDistance(a, b) <= 1);
const sameWords = (a: string[], b: string[]): boolean => a.length > 0 && a.length === b.length && a.every((w, i) => close(w, b[i]));

/** Sessions whose full or short name is the spoken name, word for word (small slips allowed). */
export function exactSessions<T extends { name: string }>(sessions: T[], spoken: string): T[] {
  const q = nameTokens(spoken);
  return sessions.filter((s) => sameWords(q, nameTokens(s.name)) || sameWords(q, nameTokens(shortName(s.name))));
}

/**
 * The sessions a spoken name points at, most certain first: an exact name; else every spoken word found in the
 * title; else (when `loose`) the best word overlap, covering at least half the spoken words. Several results mean
 * it is ambiguous.
 */
export function matchSessions<T extends { name: string }>(sessions: T[], spoken: string, loose = true): T[] {
  const q = nameTokens(spoken);
  if (!q.length) return [];
  const exact = exactSessions(sessions, spoken);
  if (exact.length) return exact;
  const compact = q.join("");
  const hits = (s: T): number => {
    const words = nameTokens(s.name);
    return q.filter((w) => words.some((n) => close(w, n))).length;
  };
  const subset = sessions.filter((s) => hits(s) === q.length || (compact.length >= 3 && nameTokens(s.name).join("").includes(compact)));
  if (subset.length || !loose) return subset;
  const scored = sessions.map((s) => ({ s, score: hits(s) }));
  const best = Math.max(0, ...scored.map((x) => x.score));
  if (!best || best * 2 < q.length) return [];
  return scored.filter((x) => x.score === best).map((x) => x.s);
}

const LEAD_VERB = new Set(["pick", "use", "open", "choose", "select", "say"]);
const LEAD_TO = new Set(["switch", "go", "talk", "change", "move"]);
const LEAD_WORD = new Set(["the", "number", "option", "choice"]);

/**
 * The number in a bare answer to a numbered list: "two", "2", "number two", "the second one", "switch to two".
 * Else null. Sound-alikes ("to", "for", "won") don't count: a lone word of noise must not pick a session.
 */
export function choiceNumber(text: string): number | null {
  let words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (LEAD_TO.has(words[0]) && words[1] === "to") words = words.slice(2);
  else if (LEAD_VERB.has(words[0])) words = words.slice(1);
  while (words.length > 1 && LEAD_WORD.has(words[0])) words = words.slice(1);
  if (words.length > 1 && (words[words.length - 1] === "one" || words[words.length - 1] === "please")) words = words.slice(0, -1);
  if (words.length !== 1) return null;
  const word = words[0];
  const digits = /^(\d+)(?:st|nd|rd|th)?$/.exec(word);
  if (digits) return Number(digits[1]) || null;
  const cardinal = CARDINALS.indexOf(word);
  if (cardinal > 0) return cardinal;
  const ordinal = ORDINALS.indexOf(word);
  return ordinal > 0 ? ordinal : null;
}
