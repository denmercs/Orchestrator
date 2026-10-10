// The replay judge: Claude Haiku decides which replayed Review findings match the recorded ones.
import { INPUT_USD_PER_TOKEN, MAX_TOKENS, MODEL, OUTPUT_USD_PER_TOKEN } from "../shared/corrections";
import { type Match, parseJudge } from "../shared/replay";
import type { HaikuOptions } from "./correction-classifier";

const URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export type Judge = (recorded: string[], replay: string[]) => Promise<{ matches: Match[] | null; costUsd: number }>;

const SYSTEM = [
  "You compare two lists of code review findings: RECORDED (what a past review found) and REPLAY (what a replayed review found).",
  "A replay finding matches a recorded finding when both point at the same underlying problem, even if worded differently.",
  'Answer with JSON only, no prose and no code fence: {"matches":[[<replay index>,<recorded index>]],"new":[<replay index>]}.',
  'Indexes are 0-based. "new" lists the replay findings that match no recorded finding.',
].join("\n");

const list = (title: string, items: string[]) => `${title}:\n${items.map((f, i) => `[${i}] ${f}`).join("\n") || "(none)"}`;

export function haikuJudge(options: HaikuOptions): Judge {
  const doFetch = options.fetch ?? globalThis.fetch;
  return async (recorded, replay) => {
    const key = typeof options.apiKey === "function" ? await options.apiKey() : options.apiKey;
    if (!key) throw new Error("Anthropic API key is missing (set ANTHROPIC_API_KEY or the anthropic-api-key Keychain item)");

    const response = await doFetch(URL, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": API_VERSION, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM,
        messages: [{ role: "user", content: `${list("RECORDED", recorded)}\n\n${list("REPLAY", replay)}` }],
      }),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Anthropic API returned ${response.status}: ${raw.slice(0, 300)}`);

    let reply: { content?: { text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } } = {};
    try {
      reply = JSON.parse(raw);
    } catch {
      // Billed but unreadable: report the cost (zero when even the envelope is unreadable) with no verdict.
    }
    const costUsd = (reply.usage?.input_tokens ?? 0) * INPUT_USD_PER_TOKEN + (reply.usage?.output_tokens ?? 0) * OUTPUT_USD_PER_TOKEN;
    const verdict = parseJudge(reply.content?.[0]?.text ?? "", replay.length, recorded.length);
    return { matches: verdict ? verdict.matches : null, costUsd };
  };
}
