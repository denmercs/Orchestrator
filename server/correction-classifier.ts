// The default cheap-model classifier: Claude Haiku over the Messages API, with an injected `fetch` and key source.
import {
  type Classify,
  INPUT_USD_PER_TOKEN,
  MAX_TOKENS,
  MODEL,
  OUTPUT_USD_PER_TOKEN,
} from "../shared/corrections";
import { CORRECTION_CATEGORIES } from "../shared/memory";
import { readKeychainSecret } from "./keychain";

const URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export type HaikuOptions = {
  fetch?: typeof globalThis.fetch;
  apiKey: string | (() => string | Promise<string>);
};

// Env first, then the macOS Keychain item `anthropic-api-key`. "" when neither has it. Never log the value.
export async function defaultApiKey(): Promise<string> {
  return process.env.ANTHROPIC_API_KEY?.trim() || (await readKeychainSecret("anthropic-api-key"));
}

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

export function haikuClassifier(options: HaikuOptions): Classify {
  const doFetch = options.fetch ?? globalThis.fetch;
  return async (batch, context) => {
    const key = typeof options.apiKey === "function" ? await options.apiKey() : options.apiKey;
    if (!key) throw new Error("Anthropic API key is missing (set ANTHROPIC_API_KEY or the anthropic-api-key Keychain item)");

    const response = await doFetch(URL, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": API_VERSION, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt(context.areas, context.phrases),
        messages: [{ role: "user", content: batch.map((o) => `[${o.id}] ${o.text}`).join("\n") }],
      }),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Anthropic API returned ${response.status}: ${raw.slice(0, 300)}`);

    let reply: { content?: { type?: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    let parsed: { filings?: unknown };
    try {
      reply = JSON.parse(raw);
      parsed = JSON.parse(unfence(reply.content?.[0]?.text ?? ""));
    } catch {
      throw new Error(`Anthropic reply was not valid JSON: ${raw.slice(0, 300)}`);
    }
    const list = Array.isArray(parsed.filings) ? parsed.filings : [];
    const filings = list.flatMap((entry: { id?: unknown; category?: unknown; area?: unknown; phrase?: unknown }) =>
      typeof entry?.id === "string" && entry.id && typeof entry.phrase === "string" && entry.phrase
        ? [{ id: entry.id, category: String(entry.category ?? ""), area: typeof entry.area === "string" ? entry.area : null, phrase: entry.phrase }]
        : [],
    );
    const costUsd = (reply.usage?.input_tokens ?? 0) * INPUT_USD_PER_TOKEN + (reply.usage?.output_tokens ?? 0) * OUTPUT_USD_PER_TOKEN;
    return { filings, costUsd };
  };
}
