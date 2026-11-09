import assert from "node:assert/strict";
import { test } from "node:test";
import { describeWeather, isBriefGreeting, JOKES, priorityInitiative, replyBrief, startBrief, type BriefData } from "./morning-brief";

// Tuesday, October 13th 2026, 7:42 AM local.
const AT = new Date(2026, 9, 13, 7, 42).getTime();
const data = (patch: Partial<BriefData> = {}): BriefData => ({
  name: "Dennis",
  at: AT,
  weather: "It's 41 degrees and clear in Portage, with a high of 55.",
  verse: { reference: "Psalm 118:24", text: "This is the day the Lord has made; let us rejoice and be glad in it." },
  stories: ["Fix playback resume", "Add retry to sync", "Trim the cache", "Audit the export"],
  initiative: { title: "Orchestration Redesign", detail: "one story needs you", running: false },
  ...patch,
});

test("a greeting, with or without the name, starts the briefing", () => {
  assert.equal(isBriefGreeting("Good morning"), true);
  assert.equal(isBriefGreeting("Sulti, good morning."), true);
  assert.equal(isBriefGreeting("brief me"), true);
  assert.equal(isBriefGreeting("good morning team, standup is at nine"), false);
  assert.equal(isBriefGreeting("start the loop"), false);
});

test("good morning plus the name in one sentence starts the briefing, in any order", () => {
  assert.equal(isBriefGreeting("Good morning, Sulti. Sulti, good morning."), true);
  assert.equal(isBriefGreeting("Hey Sulti, good morning"), true);
  assert.equal(isBriefGreeting("Hey Jarvis, good morning"), false);
  assert.equal(isBriefGreeting("Sulti, good morning to you"), true);
  assert.equal(isBriefGreeting("Hey, good morning"), true);
  assert.equal(isBriefGreeting("hello good morning"), true);
  assert.equal(isBriefGreeting("Good morning team, standup is at nine"), false);
  assert.equal(isBriefGreeting("Good morning team. Sulti, start the loop"), false);
});

test("the opening says greeting, weather, verse, then the first two stories and waits", () => {
  const r = startBrief(data());
  assert.equal(r.lines[0], "Good morning, Dennis. It's 7:42 AM, Tuesday, October 13th. It's 41 degrees and clear in Portage, with a high of 55.");
  assert.equal(r.lines[1], "Today's verse is Psalm 118:24. This is the day the Lord has made; let us rejoice and be glad in it.");
  assert.match(r.lines[2], /^You have four stories left\. First: “Fix playback resume”, then “Add retry to sync”\. Shall I continue\?$/);
});

test("go on reads the next titles, then reports the initiative without an offer", () => {
  const open = startBrief(data()).state!;
  const more = replyBrief(open, "go on");
  assert.deepEqual(more.lines.slice(0, 1), ["“Trim the cache”, then “Audit the export”."]);
  assert.equal(more.lines.at(-3), "Your priority initiative is Orchestration Redesign: one story needs you.");
  assert.equal(more.lines.at(-1), "Will that be all?");
  assert.equal(more.state, null);
});

test("more titles remain: it says how many are left and keeps waiting", () => {
  const open = startBrief(data({ stories: ["a", "b", "c", "d", "e", "f"] })).state!;
  const more = replyBrief(open, "more");
  assert.deepEqual(more.lines, ["“c”, then “d”. Two more after that."]);
});

test("skip jumps from the stories to the initiative", () => {
  const r = replyBrief(startBrief(data()).state!, "Sulti, skip");
  assert.equal(r.lines[0], "Your priority initiative is Orchestration Redesign: one story needs you.");
  assert.equal(r.state, null);
});

test("do it after the stories starts nothing and is not a briefing answer", () => {
  const open = startBrief(data()).state!;
  const r = replyBrief(open, "do it");
  assert.equal(r.passThrough, true);
  assert.deepEqual(r.lines, []);
  assert.equal("effect" in r, false);
});

test("an empty board skips straight to the initiative line; no initiative goes straight to the joke", () => {
  const clear = startBrief(data({ stories: [] }));
  assert.ok(clear.lines.includes("Your board is clear."));
  assert.doesNotMatch(clear.lines.join(" "), /Shall I start/);
  assert.equal(clear.state, null);
  const bare = startBrief(data({ stories: [], initiative: null }));
  assert.equal(bare.state, null);
  assert.equal(bare.lines.at(-1), "Will that be all?");
});

test("a running initiative is mentioned, never offered", () => {
  const r = startBrief(data({ stories: [], initiative: { title: "Orchestration Redesign", detail: "two of five stories merged", running: true } }));
  assert.equal(r.state, null);
  assert.ok(r.lines.some((l) => l.endsWith("The loop is already running.")));
});

test("stop ends it politely; other words end it and pass through to the router", () => {
  const open = startBrief(data()).state!;
  assert.deepEqual(replyBrief(open, "that's all, thanks"), { state: null, lines: ["Very good."], passThrough: false });
  const other = replyBrief(open, "tell the docs session to fix the typo");
  assert.equal(other.passThrough, true);
  assert.equal(other.state, null);
});

test("repeat says the current beat again", () => {
  const open = startBrief(data()).state!;
  const r = replyBrief(open, "say that again");
  assert.match(r.lines[0], /^You have four stories left\./);
});

test("a verse with no text says only the reference; no verse is left out", () => {
  assert.equal(startBrief(data({ verse: { reference: "Psalm 118:24", text: null } })).lines[1], "Today's verse is Psalm 118:24.");
  assert.match(startBrief(data({ verse: null })).lines[1], /^You have four stories left/);
});

test("after noon it is not good morning", () => {
  const r = startBrief(data({ at: new Date(2026, 9, 13, 14, 5).getTime() }));
  assert.match(r.lines[0], /^Good afternoon, Dennis\. It's 2:05 PM/);
});

test("weather: temperature, sky, high, and a jacket when rain is likely", () => {
  assert.equal(describeWeather("Portage", { temperature: 40.6, code: 3, high: 55.2, rainChance: 20 }), "It's 41 degrees and overcast in Portage, with a high of 55.");
  assert.equal(
    describeWeather("Portage", { temperature: 52, code: 61, high: null, rainChance: 80 }),
    "It's 52 degrees and rainy in Portage. Rain is likely, so take a jacket.",
  );
});

test("the priority initiative is the one that needs you, with the loop target to start", () => {
  const story = (status: string) => ({ id: "s", status, ready: false }) as never;
  const board = (initiative: string, title: string, stories: unknown[], loop = "off") =>
    ({ repo: "/r", initiative, error: null, state: { initiative: title, epic: { id: "phase-1", title: "P", dir: "" }, repoUrl: "", stories, loop, plan: null } }) as never;
  const picked = priorityInitiative([
    board("quiet", "Quiet One", [story("implementing"), story("todo")]),
    board("urgent", "Urgent One", [story("awaiting-approval"), story("merged")]),
    board("finished", "Finished One", [story("merged")]),
  ]);
  assert.equal(picked?.title, "Urgent One");
  assert.equal(picked?.detail, "one story needs you");
  assert.deepEqual(picked?.target, { repo: "/r", initiative: "urgent" });
  assert.equal(priorityInitiative([board("finished", "Finished One", [story("merged")])]), null);
});
