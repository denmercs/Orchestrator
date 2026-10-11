// The default cheap-model classifier: Claude Haiku through the Claude Code CLI (see claude-cli.ts).
import { type Ask, claudeCli } from "./claude-cli";
import type { Classify } from "./corrections";
import { CORRECTION_CATEGORIES } from "./memory";

function systemPrompt(areas: string[], phrases: Record<string, string[]>): string {
  const vocabulary = Object.entries(phrases)
    .filter(([, list]) => list.length > 0)
    .map(([category, list]) => `- ${category}: ${list.map((p) => JSON.stringify(p)).join(", ")}`);
  return [
    "You file observations about things that went wrong in a software project into a fixed set of correction categories.",
    `Categories (use exactly one per observation): ${CORRECTION_CATEGORIES.join(", ")}.`,
    `Areas (use exactly one id, or null if none fits): ${areas.length ? areas.join(", ") : "(none)"}.`,
    "For each observation write a short canonical phrase (an imperative rule, under 10 words). Reuse an existing phrase verbatim when it means the same thing.",
    vocabulary.length ? `Phrases already used per category:\n${vocabulary.join("\n")}` : "No phrases are in use yet.",
    'Answer with JSON only, no prose and no code fence, in this shape: {"filings":[{"id":"<observation id>","category":"<category>","area":"<area id or null>","phrase":"<phrase>"}]}',
  ].join("\n\n");
}

const unfence = (text: string) => text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

export function haikuClassifier(ask: Ask = claudeCli()): Classify {
  return async (batch, context) => {
    const { text, costUsd } = await ask(
      systemPrompt(context.areas, context.phrases),
      batch.map((o) => `[${o.id}] ${o.text}`).join("\n"),
    );
    let parsed: { filings?: unknown };
    try {
      parsed = JSON.parse(unfence(text));
    } catch {
      // The call was billed even though its text is unusable, so the error carries the cost.
      throw Object.assign(new Error(`Haiku reply was not valid JSON: ${text.slice(0, 300)}`), { costUsd });
    }
    const list = Array.isArray(parsed.filings) ? parsed.filings : [];
    const filings = list.flatMap((entry: { id?: unknown; category?: unknown; area?: unknown; phrase?: unknown }) =>
      typeof entry?.id === "string" && entry.id && typeof entry.phrase === "string" && entry.phrase
        ? [{ id: entry.id, category: String(entry.category ?? ""), area: typeof entry.area === "string" ? entry.area : null, phrase: entry.phrase }]
        : [],
    );
    return { filings, costUsd };
  };
}
