// The Jarvis panel, as data. Kept free of React and the Paseo client so it can be tested on its own.

import type { EpicBoard, EpicStory } from "../shared/orchestration";
import { CONFIRM_CANCEL, type VoiceEvent, type VoiceSession, type VoiceState } from "../shared/voice-loop";
import { noStorySessionLine, numberWord } from "../shared/voice-lines";
import { shortName } from "../shared/voice-names";
import { boardKey, nodeKind, type NodeKind } from "./epic-board-model";

export const PANEL_WIDTH = 360;
export const MIN_BOARD_WIDTH = 720;

export type PanelPlacement = "docked" | "strip" | "overlay";

// Wide enough for the board plus the panel (and not compact): docked, unless the user collapsed it to a strip.
// Otherwise the panel is a strip until the user opens it, then it lies over the dashboard. `collapsed` is the saved
// choice and only matters when docked; narrow windows ignore it and look at `opened` instead. An unknown width
// (before the first layout) counts as narrow.
export function placement(input: {
  width?: number;
  compact: boolean;
  collapsed: boolean;
  opened?: boolean;
}): PanelPlacement {
  const wide = !input.compact && (input.width ?? 0) >= PANEL_WIDTH + MIN_BOARD_WIDTH;
  if (wide) return input.collapsed ? "strip" : "docked";
  return input.opened ? "overlay" : "strip";
}

export type StoryChip = { board: string; id: string; title: string; kind: NodeKind };

// Story ids (`S10`, `CHK-14`) in one of Jarvis's lines, as chips: whole words, case-sensitive, each id once, in order
// of appearance. An id on several boards goes to the story whose agent is a known session, else the first board.
export function storyChips(text: string, boards: readonly EpicBoard[], sessions: readonly VoiceSession[]): StoryChip[] {
  const known = new Set(sessions.map((session) => session.id));
  const found = new Set<string>();
  const chips: StoryChip[] = [];
  for (const [word] of text.matchAll(/(?<![\w-])[A-Za-z][A-Za-z0-9]*(?:-\d+)?(?![\w-])/g)) {
    if (found.has(word)) continue;
    let pick: { board: EpicBoard; story: EpicStory } | null = null;
    for (const board of boards) {
      const story = board.state?.stories.find((item) => item.id === word);
      if (!story) continue;
      if (known.has(story.agent)) {
        pick = { board, story };
        break;
      }
      pick ??= { board, story };
    }
    if (!pick) continue;
    found.add(word);
    chips.push({ board: boardKey(pick.board), id: word, title: pick.story.title, kind: nodeKind(pick.story) });
  }
  return chips;
}

export type AskDraft = { target: VoiceSession; draft: string } | { target: null; draft: string; note: string };

// Ask on a story card: the target becomes the story's running agent when that agent is a known session, and the text
// box starts with the story's id and title. With no such session the target stays as it is (`currentTarget`, for the
// wording only) and a note says where the message will go.
export function askDraft(story: EpicStory, sessions: readonly VoiceSession[], currentTarget: VoiceSession | null = null): AskDraft {
  const draft = `${story.id} ${story.title}: `;
  const target = sessions.find((session) => session.id === story.agent);
  if (target) return { target, draft };
  return { target: null, draft, note: noStorySessionLine(story.id, currentTarget?.name ?? null) };
}

export type Briefing = { merged: EpicStory[]; running: EpicStory[]; needsYou: EpicStory[]; seen: Record<string, string> };

// What changed since `seen` (story id → status, saved last time): stories merged since, those running now, and those
// needing you now (plan approval, blocked, PR ready), plus the map to save next. An empty `seen` is a first run, so
// nothing counts as merged since: the first briefing isn't a wall of history.
export function briefing(stories: readonly EpicStory[], seen: Record<string, string>): Briefing {
  const first = Object.keys(seen).length === 0;
  const result: Briefing = { merged: [], running: [], needsYou: [], seen: {} };
  for (const story of stories) {
    result.seen[story.id] = story.status;
    const kind = nodeKind(story);
    if (kind === "merged") {
      if (!first && seen[story.id] !== "merged") result.merged.push(story);
    } else if (kind === "needs-you") result.needsYou.push(story);
    else if (kind === "running") result.running.push(story);
  }
  return result;
}

export type ReplyAction = { label: string; event: VoiceEvent };

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

// Buttons for the question Jarvis is holding: "One · send" / "Two · cancel" while confirming, else one numbered button
// per choice. Each carries the event the spoken answer would produce, so a tap and the word reach the same state.
export function replyActions(state: VoiceState): ReplyAction[] {
  if (state.mode === "confirming" && state.confirm) {
    return [
      { label: "One · send", event: { type: "confirm", word: state.confirm.word } },
      { label: "Two · cancel", event: { type: "confirm", word: CONFIRM_CANCEL } },
    ];
  }
  return (state.choices ?? []).map((choice, i) => ({
    label: `${capital(numberWord(i + 1))} · ${shortName(choice.name)}`,
    event: { type: "utterance", text: numberWord(i + 1) },
  }));
}
