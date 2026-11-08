// Which cheap model the one-shot calls (correction classifier, replay judge) use. With no ~/.orchestrator/ask.json
// they go through the Claude Code CLI (claude-cli.ts). With one, they go to any OpenAI-compatible chat endpoint:
// xAI, OpenAI, OpenRouter or a local Ollama, so these features need no Claude install.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Ask, claudeCli, claudeSignedIn } from "./claude-cli";
import { MAX_TOKENS } from "./corrections";

const TIMEOUT_MS = 120_000;

// `keyEnv` names the environment variable that holds the key, so no key is written to disk. Prices are USD per
// million tokens; without them a call reports no cost, and only the cost cap's worst-case estimate still applies.
const askFile = z.object({
  url: z.string().url(),
  model: z.string().min(1),
  keyEnv: z.string().min(1).optional(),
  inputUsdPerMTok: z.number().min(0).optional(),
  outputUsdPerMTok: z.number().min(0).optional(),
});
export type AskConfig = z.infer<typeof askFile>;

export const askFilePath = (home = homedir()) => join(home, ".orchestrator", "ask.json");

// The config, or null when there is no file. A broken file is an error, so a typo doesn't quietly fall back to Claude.
export function readAskConfig(file = askFilePath()): AskConfig | null {
  if (!existsSync(file)) return null;
  const parsed = askFile.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

export function openAiAsk(config: AskConfig, env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Ask {
  return async (system, prompt) => {
    const key = config.keyEnv ? env[config.keyEnv] : undefined;
    if (config.keyEnv && !key) throw new Error(`${config.keyEnv} is not set, so ${config.url} can't be called`);
    const response = await fetchFn(`${config.url.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model: config.model,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`${config.url} answered ${response.status}: ${raw.slice(0, 300)}`);
    let reply: { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
    try {
      reply = JSON.parse(raw);
    } catch {
      throw new Error(`${config.url} output was not JSON: ${raw.slice(0, 300)}`);
    }
    const content = reply.choices?.[0]?.message?.content;
    const tokens = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    const costUsd =
      (tokens(reply.usage?.prompt_tokens) * (config.inputUsdPerMTok ?? 0) +
        tokens(reply.usage?.completion_tokens) * (config.outputUsdPerMTok ?? 0)) /
      1_000_000;
    return { text: typeof content === "string" ? content : "", costUsd };
  };
}

// The configured backend, read when called so editing ask.json takes effect without a plugin reload.
export function defaultAsk(file = askFilePath()): Ask {
  return (system, prompt) => {
    const config = readAskConfig(file);
    return (config ? openAiAsk(config) : claudeCli())(system, prompt);
  };
}

// Why the one-shot model can't run, or null when it can. Never throws.
export async function askUnavailable(
  file = askFilePath(),
  signedIn: () => Promise<boolean> = claudeSignedIn,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  try {
    const config = readAskConfig(file);
    if (config) return config.keyEnv && !env[config.keyEnv] ? `${config.keyEnv} is not set (named in ${file}).` : null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return (await signedIn()) ? null : `Claude Code is not signed in. Run \`claude\` and log in, or set a model in ${file}.`;
}
