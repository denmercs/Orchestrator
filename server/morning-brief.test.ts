import assert from "node:assert/strict";
import { test } from "node:test";
import { createMorningBrief, fetchWeather, type BriefPorts } from "./morning-brief";

const board = (stories: { status: string }[]) =>
  ({
    repo: "/r",
    initiative: "redesign",
    error: null,
    state: { initiative: "Redesign", epic: { id: "phase-1", title: "P", dir: "" }, repoUrl: "", loop: "off", plan: null, stories: stories.map((s, i) => ({ id: `s${i}`, ready: false, ...s })) },
  }) as never;

function ports(patch: Partial<BriefPorts> = {}): BriefPorts & { started: unknown[] } {
  const started: unknown[] = [];
  return {
    started,
    verse: async () => ({ reference: "Psalm 118:24", text: "This is the day." }),
    stories: async () => ({
      items: [
        { summary: "Fix playback resume", statusCategory: "indeterminate" },
        { summary: "Shipped already", statusCategory: "done" },
        { summary: "Add retry", statusCategory: "new" },
      ],
      error: null,
    }),
    boards: async () => [board([{ status: "awaiting-approval" }])],
    weather: async () => ({ temperature: 41, code: 0, high: 55, rainChance: 10 }),
    startLoop: async (target) => (started.push(target), { ok: true, error: null }),
    now: () => 1_000,
    ...patch,
  };
}

test("gathers all four sources, dropping done stories", async () => {
  const data = await createMorningBrief(ports()).gather();
  assert.equal(data.weather, "It's 41 degrees and clear in Portage, with a high of 55.");
  assert.equal(data.verse?.reference, "Psalm 118:24");
  assert.deepEqual(data.stories, ["Fix playback resume", "Add retry"]);
  assert.equal(data.initiative?.title, "Redesign");
});

test("a dead source leaves its part out and keeps the rest", async () => {
  const boom = async () => Promise.reject(new Error("down"));
  const data = await createMorningBrief(ports({ weather: boom, stories: boom, boards: boom })).gather();
  assert.equal(data.weather, null);
  assert.deepEqual(data.stories, []);
  assert.equal(data.initiative, null);
  assert.equal(data.verse?.reference, "Psalm 118:24");
});

test("starting runs the loop on the initiative the briefing offered", async () => {
  const p = ports();
  const brief = createMorningBrief(p);
  assert.equal(await brief.startInitiative(), "there is nothing to start.");
  await brief.gather();
  assert.equal(await brief.startInitiative(), null);
  assert.deepEqual(p.started, [{ repo: "/r", initiative: "redesign" }]);
});

test("a loop that won't start hands back its reason", async () => {
  const p = ports({ startLoop: async () => ({ ok: false, error: "Pick a repo first." }) });
  const brief = createMorningBrief(p);
  await brief.gather();
  assert.equal(await brief.startInitiative(), "Pick a repo first.");
});

test("weather reads Open-Meteo's current reading and today's high and rain chance", async () => {
  let asked = "";
  const fake = (async (url: string) => {
    asked = url;
    return Response.json({ current: { temperature_2m: 40.6, weather_code: 3 }, daily: { temperature_2m_max: [55.2], precipitation_probability_max: [20] } });
  }) as never;
  assert.deepEqual(await fetchWeather(fake), { temperature: 40.6, code: 3, high: 55.2, rainChance: 20 });
  assert.match(asked, /latitude=43\.5391&longitude=-89\.4632/);
  await assert.rejects(fetchWeather((async () => Response.json({})) as never), /no current reading/);
});
