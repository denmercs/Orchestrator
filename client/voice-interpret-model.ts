import { HELPER_DEFAULT_ON, type InterpretOutcome } from "../shared/voice-interpreter";
import { helperFallbackNote } from "../shared/voice-lines";
import type { InterpretResult } from "../shared/voice-loop";

// Lives in shared/ so the server's interpret service can use it too.
export { HELPER_DEFAULT_ON };

const MAX_ROWS = 5;

export type InterpretEntry = { heard: string; outcome: InterpretOutcome };

export type InterpretRow = { key: number; heard: string; cleaned: string; note: string | null };

function cleanedText(result: InterpretResult): string {
  switch (result.type) {
    case "send":
      return result.text;
    case "switch":
      return `switch to ${result.name}`;
    case "sendTo":
      return `${result.text} (to ${result.session})`;
    case "drop":
      return "dropped";
  }
}

// Newest first (history is oldest first), last 5 only. `key` is the original index, stable as history grows.
export function interpretRows(history: InterpretEntry[]): InterpretRow[] {
  return history
    .map(({ heard, outcome }, key) => ({ key, heard, cleaned: cleanedText(outcome.result), note: helperFallbackNote(outcome) }))
    .slice(-MAX_ROWS)
    .reverse();
}
