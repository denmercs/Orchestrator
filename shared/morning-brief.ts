// The Jarvis morning briefing, paced like the movie: one short beat at a time, then it waits for you.
// Greeting, weather and the verse come together; then the Jira stories (titles only), the priority initiative,
// and a joke to sign off. Pure: the data is gathered elsewhere (server/morning-brief.ts) and handed in.
import { gatesOf } from "./gates";
import type { EpicBoard } from "./orchestration";
import { initiativeStatus } from "./story-steps";
import { withoutName } from "./voice-loop";

export type BriefInitiative = {
  title: string;
  /** What the board shows: "1 story needs you", "2 of 5 stories merged", … */
  detail: string;
  /** The loop is already on, so there is nothing to offer to start. */
  running: boolean;
};

export type BriefData = {
  name: string;
  /** Local time, in ms. */
  at: number;
  weather: string | null;
  verse: { reference: string; text: string | null } | null;
  /** Titles of your Jira stories that are not done, most pressing first. */
  stories: string[];
  initiative: BriefInitiative | null;
};

export type BriefStage = "stories" | "initiative";
export type BriefState = { data: BriefData; stage: BriefStage; shown: number };

export type BriefReply = {
  state: BriefState | null;
  lines: string[];
  /** Said after the effect has run (the joke), so a failed start can replace `lines` without losing it. */
  rest: string[];
  effect: "startInitiative" | null;
  /** Not a briefing answer: the briefing is over and the words go to the normal router. */
  passThrough: boolean;
};

const STORIES_PER_BEAT = 2;

export const JOKES = [
  "Why did the shepherd get a promotion? He was outstanding in his field.",
  "Why couldn't Noah catch many fish? He only had two worms.",
  "How does Moses make his tea? He Hebrews it.",
  "What did Adam say the day before Christmas? It's Christmas, Eve.",
  "Why didn't the two animals on the ark play cards? Noah was standing on the deck.",
  "Who was the fastest runner in the Bible? Adam. He was first in the human race.",
  "What did Jonah say when the big fish spat him out? That was a whale of a ride.",
  "Who was the greatest financier in the Bible? Noah. He was floating stock while everyone else was in liquidation.",
];

const jokeFor = (at: number): string => JOKES[Math.floor(at / 86_400_000) % JOKES.length];

const GREETING = /^(?:good (?:morning|day)|morning briefing|brief me|give me (?:the|my) (?:morning )?(?:brief|briefing)|morning)\b/;
const GO = /^(?:yes|yeah|yep|yup|sure|ok|okay|please|go on|go ahead|continue|more|next|what else|and|keep going|read (?:them|more))\b/;
const START = /^(?:yes|yeah|yep|yup|sure|ok|okay|please|do it|start|start it|go ahead|go|kick it off|make it so)\b/;
const SKIP = /^(?:skip|no|nope|not now|not yet|later|pass|next one|move on)\b/;
const STOP = /^(?:stop|that s all|that will be all|that is all|enough|thanks|thank you|cancel|never mind|nevermind|dismissed|i m good|that s enough)\b/;
const REPEAT = /^(?:repeat|say that again|again|what was that|come again)\b/;

const norm = (text: string): string =>
  withoutName(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

/** "Good morning" (optionally after the name) starts the briefing. */
export const isBriefGreeting = (text: string): boolean => {
  const said = norm(text);
  // Short only: "good morning team, standup is at nine" is for someone else.
  return GREETING.test(said) && said.split(" ").length <= 4;
};

const hourOf = (at: number): number => new Date(at).getHours();
const salutation = (at: number): string => (hourOf(at) < 12 ? "Good morning" : hourOf(at) < 17 ? "Good afternoon" : "Good evening");

function clock(at: number): string {
  const d = new Date(at);
  const h = d.getHours() % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${d.getHours() < 12 ? "AM" : "PM"}`;
}

function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;
}

function dayLine(at: number): string {
  const d = new Date(at);
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
  const month = d.toLocaleDateString("en-US", { month: "long" });
  return `${weekday}, ${month} ${ordinal(d.getDate())}`;
}

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const count = (n: number): string => NUMBER_WORDS[n] ?? String(n);
const quote = (title: string): string => `“${title}”`;

// Open-Meteo weather codes, as a phrase after "and".
const SKY: [number, string][] = [
  [0, "clear"], [1, "mostly clear"], [2, "partly cloudy"], [3, "overcast"], [45, "foggy"], [48, "foggy"],
  [51, "drizzling"], [53, "drizzling"], [55, "drizzling"], [56, "drizzling"], [57, "drizzling"],
  [61, "rainy"], [63, "rainy"], [65, "rainy"], [66, "rainy"], [67, "rainy"], [71, "snowy"], [73, "snowy"], [75, "snowy"], [77, "snowy"],
  [80, "showery"], [81, "showery"], [82, "showery"], [85, "snowy"], [86, "snowy"], [95, "stormy"], [96, "stormy"], [99, "stormy"],
];

export type RawWeather = { temperature: number; code: number; high: number | null; rainChance: number | null };

/** One spoken sentence or two, with a practical hint when it matters. */
export function describeWeather(place: string, raw: RawWeather): string {
  const sky = SKY.find(([code]) => code === raw.code)?.[1] ?? "unsettled";
  const head = `It's ${Math.round(raw.temperature)} degrees and ${sky} in ${place}`;
  const high = raw.high === null ? "." : `, with a high of ${Math.round(raw.high)}.`;
  const snow = raw.code >= 71 && raw.code <= 77;
  const hint = raw.rainChance !== null && raw.rainChance >= 50 ? (snow ? " Dress warm, it'll snow." : " Rain is likely, so take a jacket.") : "";
  return head + high + hint;
}

/** The board's most pressing initiative: needs you, then in progress, then ready, then still planning. Done ones are skipped. */
export function priorityInitiative(boards: EpicBoard[]): (BriefInitiative & { target: { repo: string; initiative: string } }) | null {
  const RANK: Record<string, number> = { "Needs you": 0, "In progress": 1, Ready: 2, Planning: 3, "Needs plan": 4 };
  let best: { rank: number; gates: number; value: NonNullable<ReturnType<typeof priorityInitiative>> } | null = null;
  for (const board of boards) {
    const state = board.state;
    if (!state) continue;
    const badge = initiativeStatus(state);
    const rank = RANK[badge];
    if (rank === undefined) continue;
    const gates = gatesOf([board]).length;
    const merged = state.stories.filter((s) => s.status === "merged").length;
    const detail =
      badge === "Needs you"
        ? `${count(gates)} ${gates === 1 ? "story needs" : "stories need"} you`
        : badge === "In progress" || badge === "Ready"
          ? `${count(merged)} of ${count(state.stories.length)} stories merged`
          : badge === "Planning"
            ? "it's being planned"
            : "it needs a plan";
    const value = {
      title: state.initiative || board.initiative,
      detail,
      running: state.loop === "on",
      target: { repo: board.repo, initiative: board.initiative },
    };
    if (!best || rank < best.rank || (rank === best.rank && gates > best.gates)) best = { rank, gates, value };
  }
  return best?.value ?? null;
}

const reply = (patch: Partial<BriefReply>): BriefReply => ({ state: null, lines: [], rest: [], effect: null, passThrough: false, ...patch });

function storiesBeat(data: BriefData, shown: number): string {
  const next = data.stories.slice(shown, shown + STORIES_PER_BEAT);
  const left = data.stories.length - shown - next.length;
  const titles = next.map(quote).join(", then ");
  if (shown === 0) {
    const total = data.stories.length;
    return `You have ${count(total)} ${total === 1 ? "story" : "stories"} left. ${total === 1 ? "It's" : "First"}: ${titles}.${left > 0 ? " Shall I continue?" : ""}`;
  }
  return `${titles}.${left > 0 ? ` ${capital(count(left))} more after that.` : ""}`;
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

function initiativeBeat(data: BriefData): { line: string; offer: boolean } | null {
  const i = data.initiative;
  if (!i) return null;
  if (i.running) return { line: `Your priority initiative is ${i.title}: ${i.detail}. The loop is already running.`, offer: false };
  return { line: `Your priority initiative is ${i.title}: ${i.detail}. Shall I start the loop?`, offer: true };
}

/** Where the briefing goes after the stories: the initiative offer if there is one, else the sign-off. */
function toInitiative(data: BriefData, lines: string[]): BriefReply {
  const beat = initiativeBeat(data);
  if (beat?.offer) return reply({ state: { data, stage: "initiative", shown: 0 }, lines: [...lines, beat.line] });
  return reply({ lines: [...lines, ...(beat ? [beat.line] : []), ...signOff(data)] });
}

const signOff = (data: BriefData): string[] => [jokeFor(data.at), "Will that be all?"];

/** The opening: greeting, weather, verse, then the first stories. Waits for you after the stories when there are more. */
export function startBrief(data: BriefData): BriefReply {
  const lines = [`${salutation(data.at)}, ${data.name}. It's ${clock(data.at)}, ${dayLine(data.at)}.${data.weather ? ` ${data.weather}` : ""}`];
  if (data.verse) {
    lines.push(
      data.verse.text ? `Today's verse is ${data.verse.reference}. ${data.verse.text}` : `Today's verse is ${data.verse.reference}.`,
    );
  }
  if (data.stories.length === 0) return toInitiative(data, [...lines, "Your board is clear."]);
  const shown = Math.min(data.stories.length, STORIES_PER_BEAT);
  lines.push(storiesBeat(data, 0));
  if (shown < data.stories.length) return reply({ state: { data, stage: "stories", shown }, lines });
  return toInitiative(data, lines);
}

/** Your answer to the beat just spoken. Words that are not an answer end the briefing and go to the normal router. */
export function replyBrief(state: BriefState, text: string): BriefReply {
  const said = norm(text);
  const { data } = state;
  if (STOP.test(said)) return reply({ lines: ["Very good."] });
  if (REPEAT.test(said)) {
    const last = state.stage === "stories" ? storiesBeat(data, Math.max(0, state.shown - STORIES_PER_BEAT)) : (initiativeBeat(data)?.line ?? "");
    return reply({ state, lines: [last] });
  }
  if (state.stage === "stories") {
    if (GO.test(said)) {
      const shown = Math.min(data.stories.length, state.shown + STORIES_PER_BEAT);
      const line = storiesBeat(data, state.shown);
      return shown < data.stories.length ? reply({ state: { data, stage: "stories", shown }, lines: [line] }) : toInitiative(data, [line]);
    }
    if (SKIP.test(said)) return toInitiative(data, []);
    return reply({ passThrough: true });
  }
  if (START.test(said)) {
    return reply({ lines: [`Starting ${data.initiative?.title ?? "it"}.`], rest: signOff(data), effect: "startInitiative" });
  }
  if (SKIP.test(said)) return reply({ lines: signOff(data) });
  return reply({ passThrough: true });
}
