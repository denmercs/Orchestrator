import assert from "node:assert/strict";
import { test } from "node:test";
import type { EpicBoard, EpicStory } from "../shared/orchestration";
import { initialVoiceState, step, CONFIRM_CANCEL, type VoiceSession, type VoiceState } from "../shared/voice-loop";
import { numberWord } from "../shared/voice-lines";
import { boardKey } from "./epic-board-model";
import { MIN_BOARD_WIDTH, PANEL_WIDTH, askDraft, briefing, placement, replyActions, storyChips } from "./jarvis-panel-model";

test("placement docks the panel when the board and the panel both fit", () => {
  assert.equal(PANEL_WIDTH, 360);
  assert.equal(MIN_BOARD_WIDTH, 720);
  assert.equal(placement({ width: 1080, compact: false, collapsed: false }), "docked");
  assert.equal(placement({ width: 1600, compact: false, collapsed: false }), "docked");
});

test("placement shows a strip on a wide window when the user collapsed the panel", () => {
  assert.equal(placement({ width: 1600, compact: false, collapsed: true }), "strip");
});

test("placement shows a strip on a narrow window, whatever was saved as collapsed", () => {
  assert.equal(placement({ width: 1079, compact: false, collapsed: false }), "strip");
  assert.equal(placement({ width: 1079, compact: false, collapsed: true }), "strip");
});

test("placement lies over a narrow window only once the user has opened it", () => {
  assert.equal(placement({ width: 900, compact: false, collapsed: false, opened: true }), "overlay");
  assert.equal(placement({ width: 900, compact: false, collapsed: true, opened: true }), "overlay");
  assert.equal(placement({ width: 900, compact: false, collapsed: false, opened: false }), "strip");
});

test("placement treats compact like a narrow window, however wide", () => {
  assert.equal(placement({ width: 1600, compact: true, collapsed: false }), "strip");
  assert.equal(placement({ width: 1600, compact: true, collapsed: false, opened: true }), "overlay");
});

test("placement treats an unknown width as narrow, never docked", () => {
  assert.equal(placement({ width: 0, compact: false, collapsed: false }), "strip");
  assert.equal(placement({ width: undefined, compact: false, collapsed: false }), "strip");
  assert.equal(placement({ width: undefined, compact: false, collapsed: false, opened: true }), "overlay");
});

function chipStory(id: string, rest: Partial<EpicStory> = {}): EpicStory {
  return { id, title: `Title ${id}`, status: "todo", agent: "", ready: false, ...rest } as unknown as EpicStory;
}

function chipBoard(stories: EpicStory[], initiative = "redesign"): EpicBoard {
  return { repo: "/repo", initiative, state: { stories }, error: null } as unknown as EpicBoard;
}

test("storyChips finds ids in a line, in order, and skips an id that is only part of another", () => {
  const one = chipBoard([chipStory("S1"), chipStory("S10"), chipStory("CHK-14", { status: "merged" })]);
  assert.deepEqual(storyChips("CHK-14 is done, S10 is next, S1x and XS10 are not ids", [one], []), [
    { board: boardKey(one), id: "CHK-14", title: "Title CHK-14", kind: "merged" },
    { board: boardKey(one), id: "S10", title: "Title S10", kind: "waiting" },
  ]);
  assert.deepEqual(storyChips("S1 then S1", [one], []).map((chip) => chip.id), ["S1"]);
  assert.deepEqual(storyChips("s10 and S99", [one], []), []);
});

test("storyChips sends a repeated id to the board whose story has a known session, else the first board", () => {
  const first = chipBoard([chipStory("S1")], "first");
  const second = chipBoard([chipStory("S1", { agent: "a1", status: "planning" })], "second");
  assert.equal(storyChips("S1", [first, second], [{ id: "a1", name: "Ann" }])[0]?.board, boardKey(second));
  assert.equal(storyChips("S1", [first, second], [])[0]?.board, boardKey(first));
  assert.equal(storyChips("S1", [chipBoard([]), { ...first, state: null }, second], [])[0]?.board, boardKey(second));
});

test("askDraft targets the story's running agent when it is a known session, and fills the text box", () => {
  const story = chipStory("S17", { title: "Dock Jarvis beside the dashboard", agent: "a1" });
  const sessions = [{ id: "a0", name: "Other" }, { id: "a1", name: "S17 Dock" }];
  assert.deepEqual(askDraft(story, sessions, sessions[0]), { target: sessions[1], draft: "S17 Dock Jarvis beside the dashboard: " });
});

test("askDraft leaves the target alone and says so when the story has no session", () => {
  const story = chipStory("S17", { title: "Dock Jarvis beside the dashboard", agent: "gone" });
  const sessions = [{ id: "a0", name: "Other" }];
  assert.deepEqual(askDraft(story, sessions, sessions[0]), {
    target: null,
    draft: "S17 Dock Jarvis beside the dashboard: ",
    note: "S17 has no session, so this goes to Other.",
  });
  assert.deepEqual(askDraft(chipStory("S1", { title: "T" }), sessions, null), { target: null, draft: "S1 T: ", note: "S1 has no session, and no target is picked yet. Pick a session first." });
});

test("briefing lists what merged since the saved map, what runs now and what needs you, and the next map", () => {
  const board = chipBoard([
    chipStory("S1", { status: "merged" }),
    chipStory("S2", { status: "merged" }),
    chipStory("S3", { status: "implementing", agent: "a1" }),
    chipStory("S4", { status: "blocked" }),
    chipStory("S5", { status: "merged" }),
  ]);
  const key = (id: string) => `${boardKey(board)}\n${id}`;
  const seen = { [key("S1")]: "merged", [key("S2")]: "implementing", [key("S3")]: "planning", [key("S4")]: "todo" };
  const result = briefing([board], seen);
  assert.deepEqual(result.merged.map((story) => story.id), ["S2", "S5"]);
  assert.deepEqual(result.running.map((story) => story.id), ["S3"]);
  assert.deepEqual(result.needsYou.map((story) => story.id), ["S4"]);
  assert.deepEqual(result.seen, { [key("S1")]: "merged", [key("S2")]: "merged", [key("S3")]: "implementing", [key("S4")]: "blocked", [key("S5")]: "merged" });
});

test("briefing on a first run (empty map) reports nothing as merged since, but still fills the map", () => {
  const board = chipBoard([chipStory("S1", { status: "merged" }), chipStory("S2", { status: "implementing" })]);
  const result = briefing([board], {});
  assert.deepEqual(result.merged, []);
  assert.deepEqual(result.running.map((story) => story.id), ["S2"]);
  assert.deepEqual(result.seen, { [`${boardKey(board)}\nS1`]: "merged", [`${boardKey(board)}\nS2`]: "implementing" });
});

test("briefing tells apart the same id on two initiatives, so a repeat id is not reported as merged every time", () => {
  const first = chipBoard([chipStory("S1", { status: "merged" })], "first");
  const second = chipBoard([chipStory("S1", { status: "todo" })], "second");
  const once = briefing([first, second], { other: "todo" });
  const again = briefing([first, second], once.seen);
  assert.deepEqual(again.merged, []);
});

test("briefing keeps the saved statuses of an initiative it could not read this time", () => {
  const ok = chipBoard([chipStory("S1", { status: "implementing" })], "ok");
  const failed = chipBoard([chipStory("S2", { status: "todo" })], "failed");
  const seen = briefing([ok, failed], { other: "todo" }).seen;
  const result = briefing([ok, { ...failed, state: null }], seen);
  assert.equal(result.seen[`${boardKey(failed)}\nS2`], "todo");
});

const voiceApi: VoiceSession = { id: "s1", name: "api-refactor" };
const voiceDocs: VoiceSession = { id: "s2", name: "S17 Dock — docs" };
const voiceState = (patch: Partial<VoiceState>): VoiceState => ({ ...initialVoiceState(), mode: "listening", session: voiceApi, sessions: [voiceApi, voiceDocs], ...patch });

test("replyActions gives no buttons when nothing is being asked", () => {
  assert.deepEqual(replyActions(voiceState({})), []);
});

test("replyActions gives the confirm pair, and each button does what the spoken word does", () => {
  const state = voiceState({ mode: "confirming", confirm: { word: "merge", text: "Merge it" } });
  const [send, cancel] = replyActions(state);
  assert.deepEqual(replyActions(state).map((action) => action.label), ["One · send", "Two · cancel"]);
  assert.deepEqual(send.event, { type: "confirm", word: "merge" });
  assert.deepEqual(cancel.event, { type: "confirm", word: CONFIRM_CANCEL });
  assert.deepEqual(step(state, send.event), step(state, { type: "utterance", text: "one" }));
  assert.deepEqual(step(state, cancel.event), step(state, { type: "utterance", text: "two" }));
});

test("replyActions gives one numbered button per choice, and each button does what the spoken number does", () => {
  const state = voiceState({ session: null, choices: [voiceApi, voiceDocs] });
  const actions = replyActions(state);
  assert.deepEqual(actions.map((action) => action.label), ["One · api-refactor", "Two · S17 Dock"]);
  actions.forEach((action, i) => {
    assert.deepEqual(action.event, { type: "utterance", text: numberWord(i + 1) });
    assert.deepEqual(step(state, action.event), step(state, { type: "utterance", text: ["one", "two"][i] }));
  });
});

test("replyActions prefers the confirm pair when a confirm and a list are both held", () => {
  const state = voiceState({ mode: "confirming", confirm: { word: "send", text: "x" }, choices: [voiceApi] });
  assert.deepEqual(replyActions(state).map((action) => action.label), ["One · send", "Two · cancel"]);
});
