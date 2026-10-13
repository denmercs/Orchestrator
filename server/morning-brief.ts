// Gathers what the morning briefing says (see shared/morning-brief.ts): weather, the verse of the day, your Jira
// stories and the priority initiative. Every source is a port and fails alone, so a dead Jira still gets you the
// weather and the verse. Wired to the real sources in index.server.ts.
import type { BriefData } from "../shared/morning-brief";
import { describeWeather, priorityInitiative, type RawWeather } from "../shared/morning-brief";
import type { EpicBoard } from "../shared/orchestration";

// Portage, Wisconsin.
export const BRIEF_PLACE = { name: "Portage", latitude: 43.5391, longitude: -89.4632, timezone: "America/Chicago" };
export const BRIEF_NAME = "Dennis";
const WEATHER_TIMEOUT_MS = 4000;

type Fetch = typeof fetch;

export type BriefPorts = {
  verse(): Promise<{ reference: string; text: string | null }>;
  /** Your Jira stories, in the order to say them; `done` ones are dropped here. */
  stories(): Promise<{ items: { summary: string; statusCategory: string }[]; error: string | null }>;
  boards(): Promise<EpicBoard[]>;
  weather(): Promise<RawWeather>;
  startLoop(target: { repo: string; initiative: string }): Promise<{ ok: boolean; error: string | null }>;
  now?(): number;
};

/** Open-Meteo: no key. Current conditions plus today's high and rain chance. */
export async function fetchWeather(fetchImpl: Fetch = fetch): Promise<RawWeather> {
  const { latitude, longitude, timezone } = BRIEF_PLACE;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&current=temperature_2m,weather_code&daily=temperature_2m_max,precipitation_probability_max` +
    `&temperature_unit=fahrenheit&timezone=${encodeURIComponent(timezone)}&forecast_days=1`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(WEATHER_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`weather: HTTP ${response.status}`);
  const body = (await response.json()) as {
    current?: { temperature_2m?: number; weather_code?: number };
    daily?: { temperature_2m_max?: (number | null)[]; precipitation_probability_max?: (number | null)[] };
  };
  const { temperature_2m: temperature, weather_code: code } = body.current ?? {};
  if (typeof temperature !== "number" || typeof code !== "number") throw new Error("weather: no current reading");
  return {
    temperature,
    code,
    high: body.daily?.temperature_2m_max?.[0] ?? null,
    rainChance: body.daily?.precipitation_probability_max?.[0] ?? null,
  };
}

export function createMorningBrief(ports: BriefPorts) {
  const now = ports.now ?? Date.now;
  // The initiative the last briefing offered, so "do it" starts that one and not whatever ranks first by then.
  let offered: { repo: string; initiative: string } | null = null;

  async function gather(): Promise<BriefData> {
    const [weather, verse, stories, boards] = await Promise.allSettled([ports.weather(), ports.verse(), ports.stories(), ports.boards()]);
    const initiative = boards.status === "fulfilled" ? priorityInitiative(boards.value) : null;
    offered = initiative?.target ?? null;
    return {
      name: BRIEF_NAME,
      at: now(),
      weather: weather.status === "fulfilled" ? describeWeather(BRIEF_PLACE.name, weather.value) : null,
      verse: verse.status === "fulfilled" ? verse.value : null,
      stories:
        stories.status === "fulfilled"
          ? stories.value.items.filter((item) => item.statusCategory.toLowerCase() !== "done").map((item) => item.summary)
          : [],
      initiative,
    };
  }

  async function startInitiative(): Promise<string | null> {
    if (!offered) return "there is nothing to start.";
    const result = await ports.startLoop(offered);
    return result.ok ? null : (result.error ?? "the loop wouldn't start.");
  }

  return { gather, startInitiative };
}
