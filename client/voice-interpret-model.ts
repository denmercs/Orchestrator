import type { InterpretOutcome } from "../shared/voice-interpreter";
import type { InterpretResult } from "../shared/voice-loop";

// The helper switch starts on; the drawer lets the user turn it off.
export const HELPER_DEFAULT_ON = true;

const MAX_ROWS = 5;

export type InterpretEntry = { heard: string; outcome: InterpretOutcome };

export type InterpretRow = { key: number; heard: string; cleaned: string; note: string | null };

function cleanedText(result: InterpretResult): string {
  switch (result.type) {
    case "send":
    case "confirm":
      return result.text;
    case "switch":
      return `switch to ${result.name}`;
    case "drop":
      return "dropped";
  }
}

function fallbackNote({ via, reason }: InterpretOutcome): string | null {
  if (via !== "passThrough" || !reason) return null;
  return reason === "timeout" ? "Helper timed out, sent as heard" : "Helper failed, sent as heard";
}

// Newest first (history is oldest first), last 5 only. `key` is the original index, stable as history grows.
export function interpretRows(history: InterpretEntry[]): InterpretRow[] {
  return history
    .map(({ heard, outcome }, key) => ({ key, heard, cleaned: cleanedText(outcome.result), note: fallbackNote(outcome) }))
    .slice(-MAX_ROWS)
    .reverse();
}
