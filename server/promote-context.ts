// Compact an originating chat into `.harness/context.md` for a promoted story, so the planner
// reads it as background on its first turn. "Soft" by design: any failure (missing API key, SDK
// error, timeout, filesystem) is logged into the result and swallowed — the Promote succeeds as
// long as the ticket was created.
//
// Design decisions locked by the PR brief:
// - Model: `claude-haiku-4-5-20251001` (small, fast, cheap)
// - Timeout: 5 seconds (longer feels slow in the Promote flow)
// - API key: `process.env.ANTHROPIC_API_KEY`; absent → fall back to raw user prompts
// - Fallback: last ~10 user prompts, trimmed to 2k chars total
// - state.md pointer appended under `## Status` idempotently (no-op if already present)

import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Timeline items we care about: user prompts and assistant responses, nothing else (tool calls,
// reasoning blocks, system notes are noise for a planning-background summary).
export type ChatMessage = { role: "user" | "assistant"; text: string };

export type CarryResult = {
  wrote: boolean;
  path: string | null;
  fallback: boolean;
  error: string | null;
};

const STATE_POINTER = "See .harness/context.md for background from the chat that started this story.";

const SUMMARY_PROMPT =
  "Summarize this chat as background for a new story planning session. Problem being discussed, approach so far, any decisions. Max ~200 words. Plain text, no preamble.";

const CONTEXT_LEAD_IN = "The user promoted this chat; here's what led up to it:";

// The Anthropic client is injected so tests can swap in a fake (or a thrower).
export type AnthropicClient = {
  messages: {
    create: (args: {
      model: string;
      max_tokens: number;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    }) => Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
};

// Minimal shape of what we need from `paseo.agents.ref(id).timeline.refetch(...)`. Kept narrow so
// the tests can hand us a canned timeline without constructing a full Paseo handle.
export type TimelinePort = {
  agents: {
    ref: (agentId: string) => {
      timeline: {
        refetch: (opts: { direction: "tail"; limit: number }) => Promise<{
          entries: Array<{ item: { type: string; text?: string } }>;
        }>;
      };
    };
  };
};

export type CarryInput = {
  paseo: TimelinePort;
  sourceAgentId: string | null;
  worktree: string;
  // Dependency injection so tests can stand in for the SDK without a network.
  anthropicFactory?: (apiKey: string) => AnthropicClient;
  // Overridable for tests; defaults to process.env.ANTHROPIC_API_KEY at call time.
  apiKey?: string | null;
  // Overridable for tests; a short timeout keeps the Promote flow snappy.
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 5_000;
const TIMELINE_LIMIT = 50;
const RAW_FALLBACK_PROMPT_COUNT = 10;
const RAW_FALLBACK_MAX_CHARS = 2_000;
const SUMMARY_MAX_TOKENS = 400; // ~200 words, with headroom

function defaultFactory(apiKey: string): AnthropicClient {
  // The real SDK's shape is compatible with the narrowed AnthropicClient type above.
  return new Anthropic({ apiKey }) as unknown as AnthropicClient;
}

// Filter a Paseo timeline page down to user/assistant text turns, in chronological order (the
// refetch returns newest-first for direction: "tail", so we reverse before returning).
export function filterChatMessages(
  entries: Array<{ item: { type: string; text?: string } }>,
): ChatMessage[] {
  const picked: ChatMessage[] = [];
  for (const entry of entries) {
    const item = entry.item;
    if (!item || typeof item.text !== "string" || !item.text.trim()) continue;
    if (item.type === "user_message") picked.push({ role: "user", text: item.text });
    else if (item.type === "assistant_message") picked.push({ role: "assistant", text: item.text });
  }
  return picked;
}

// Last ~N user prompts, trimmed to maxChars total (newest-first order flipped to chronological so
// the planner reads it the way the user asked it).
export function rawFallback(messages: ChatMessage[]): string {
  const prompts = messages.filter((m) => m.role === "user").slice(-RAW_FALLBACK_PROMPT_COUNT);
  const joined = prompts.map((m) => `- ${m.text.trim()}`).join("\n");
  if (joined.length <= RAW_FALLBACK_MAX_CHARS) return joined;
  return joined.slice(0, RAW_FALLBACK_MAX_CHARS - 1) + "…";
}

// Call Haiku with a hard timeout. Returns null on any failure (caller falls back).
async function summarize(
  client: AnthropicClient,
  messages: ChatMessage[],
  timeoutMs: number,
): Promise<string | null> {
  const transcript = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text.trim()}`)
    .join("\n\n");
  const prompt = `${SUMMARY_PROMPT}\n\n---\n${transcript}`;
  const call = client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: SUMMARY_MAX_TOKENS,
    messages: [{ role: "user", content: prompt }],
  });
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const result = await Promise.race([call.then((r) => r), timeout]).catch(() => null);
  if (!result) return null;
  const text = (result.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
    .trim();
  return text || null;
}

function contextBody(summary: string, now: Date): string {
  const iso = now.toISOString().slice(0, 10);
  return `## Chat context (${iso})\n\n${CONTEXT_LEAD_IN}\n\n${summary.trim()}\n`;
}

// Append the pointer under `## Status` if (and only if) that exact line isn't already present
// anywhere in the file. The ## Status section is the natural home — the planner reads it to
// resume the step, and this makes the context file discoverable from there.
export function appendStatePointer(state: string): string {
  if (state.includes(STATE_POINTER)) return state;
  const trimmed = state.endsWith("\n") ? state : state + "\n";
  // Find the `## Status` header; if missing, append a new Status section with the pointer.
  const statusIdx = trimmed.search(/^## Status\s*$/m);
  if (statusIdx === -1) {
    return `${trimmed}\n## Status\n${STATE_POINTER}\n`;
  }
  // Insert the pointer at the end of the Status section (before the next `## ` heading, or EOF).
  const afterHeader = trimmed.indexOf("\n", statusIdx) + 1;
  const nextHeader = trimmed.slice(afterHeader).search(/^## /m);
  const sectionEnd = nextHeader === -1 ? trimmed.length : afterHeader + nextHeader;
  const section = trimmed.slice(afterHeader, sectionEnd);
  const sectionTrimmed = section.replace(/\s+$/, "");
  const rebuilt = sectionTrimmed
    ? `${sectionTrimmed}\n${STATE_POINTER}\n`
    : `${STATE_POINTER}\n`;
  return trimmed.slice(0, afterHeader) + rebuilt + (nextHeader === -1 ? "" : "\n" + trimmed.slice(sectionEnd).replace(/^\n+/, ""));
}

export async function carryChatContext(input: CarryInput): Promise<CarryResult> {
  const { paseo, sourceAgentId, worktree } = input;
  if (!sourceAgentId) {
    return { wrote: false, path: null, fallback: false, error: null };
  }
  const apiKey = input.apiKey ?? process.env.ANTHROPIC_API_KEY ?? null;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const factory = input.anthropicFactory ?? defaultFactory;

  try {
    const page = await paseo.agents
      .ref(sourceAgentId)
      .timeline.refetch({ direction: "tail", limit: TIMELINE_LIMIT });
    const messages = filterChatMessages(page.entries ?? []);
    if (messages.length === 0) {
      return { wrote: false, path: null, fallback: false, error: "no messages in chat" };
    }

    let body: string;
    let fallback = false;
    let errorNote: string | null = null;

    if (!apiKey) {
      body = rawFallback(messages);
      fallback = true;
    } else {
      let summary: string | null = null;
      try {
        const client = factory(apiKey);
        summary = await summarize(client, messages, timeoutMs);
      } catch (cause) {
        errorNote = cause instanceof Error ? cause.message : String(cause);
      }
      if (summary) {
        body = summary;
      } else {
        body = rawFallback(messages);
        fallback = true;
      }
    }

    const harnessDir = join(worktree, ".harness");
    mkdirSync(harnessDir, { recursive: true });
    const contextPath = join(harnessDir, "context.md");
    writeFileSync(contextPath, contextBody(body, new Date()), "utf8");

    const stateFile = join(harnessDir, "state.md");
    if (existsSync(stateFile)) {
      const state = readFileSync(stateFile, "utf8");
      const updated = appendStatePointer(state);
      if (updated !== state) writeFileSync(stateFile, updated, "utf8");
    }

    return { wrote: true, path: contextPath, fallback, error: errorNote };
  } catch (cause) {
    return {
      wrote: false,
      path: null,
      fallback: false,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
