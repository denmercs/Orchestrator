import type { DailyVerse } from "../shared/orchestration";

// The header's one verse line: the quote (the view truncates it) and the reference
// after it. Reference-only sources get no quote and no translation. Copyright is
// deliberately not shown (d5).
export function verseLine(verse: DailyVerse): { quote: string | null; meta: string } {
  if (!verse.text) {
    return { quote: null, meta: verse.reference };
  }
  return { quote: `“${verse.text}”`, meta: `${verse.reference} · ${verse.translation}` };
}
