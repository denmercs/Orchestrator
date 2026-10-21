import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendStatePointer,
  carryChatContext,
  filterChatMessages,
  rawFallback,
  type AnthropicClient,
  type TimelinePort,
} from "./promote-context";

const POINTER = "See .harness/context.md for background from the chat that started this story.";

function makePaseo(entries: Array<{ item: { type: string; text?: string } }>): TimelinePort {
  return {
    agents: {
      ref: () => ({
        timeline: {
          refetch: async () => ({ entries }),
        },
      }),
    },
  };
}

function fakeClient(reply: string): AnthropicClient {
  return {
    messages: {
      create: async () => ({ content: [{ type: "text", text: reply }] }),
    },
  };
}

function throwingClient(message: string): AnthropicClient {
  return {
    messages: {
      create: async () => {
        throw new Error(message);
      },
    },
  };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "promote-ctx-"));
}

test("filterChatMessages keeps user and assistant text, drops tool and empty entries", () => {
  const entries = [
    { item: { type: "user_message", text: "hello" } },
    { item: { type: "tool_use", text: "ignored" } },
    { item: { type: "assistant_message", text: "hi there" } },
    { item: { type: "assistant_message", text: "   " } },
    { item: { type: "reasoning", text: "thought" } },
    { item: { type: "user_message", text: "second question" } },
  ];
  const picked = filterChatMessages(entries);
  assert.deepEqual(picked, [
    { role: "user", text: "hello" },
    { role: "assistant", text: "hi there" },
    { role: "user", text: "second question" },
  ]);
});

test("rawFallback takes the last ~10 user prompts, trims to 2k chars", () => {
  const messages = Array.from({ length: 12 }, (_, i) => ({
    role: "user" as const,
    text: `prompt ${i + 1}`,
  }));
  const out = rawFallback(messages);
  // Last 10 are kept, oldest two dropped.
  assert.ok(out.includes("prompt 3"));
  assert.ok(out.includes("prompt 12"));
  assert.ok(!out.includes("prompt 1\n"));
  assert.ok(!out.includes("prompt 2\n"));
});

test("rawFallback trims when combined length exceeds 2k chars", () => {
  const big = "x".repeat(500);
  const messages = Array.from({ length: 10 }, () => ({ role: "user" as const, text: big }));
  const out = rawFallback(messages);
  assert.ok(out.length <= 2_000);
  assert.ok(out.endsWith("…"));
});

test("appendStatePointer adds the pointer under ## Status and is idempotent", () => {
  const seed = "# S1\n\n## Status\nimplement-running\n\n## Plan\nchange X\n";
  const once = appendStatePointer(seed);
  assert.ok(once.includes(POINTER));
  // Pointer sits inside the Status section, not after Plan.
  const statusBlock = once.split("## Plan")[0];
  assert.ok(statusBlock.includes(POINTER));
  const twice = appendStatePointer(once);
  assert.equal(twice, once, "second call is a no-op");
});

test("appendStatePointer creates a Status section when the file has none", () => {
  const seed = "# S1\n\n## Plan\nchange X\n";
  const out = appendStatePointer(seed);
  assert.ok(out.includes("## Status"));
  assert.ok(out.includes(POINTER));
});

test("carryChatContext writes context.md with the Haiku summary and updates state.md", async () => {
  const worktree = tmp();
  mkdirSync(join(worktree, ".harness"), { recursive: true });
  writeFileSync(
    join(worktree, ".harness", "state.md"),
    "# PROMOTE-1\n\n## Status\nplan-running\n",
    "utf8",
  );

  const paseo = makePaseo([
    { item: { type: "user_message", text: "I keep losing context when I switch chats" } },
    { item: { type: "assistant_message", text: "Here are three options..." } },
  ]);

  const result = await carryChatContext({
    paseo,
    sourceAgentId: "agent-1",
    worktree,
    apiKey: "test-key",
    anthropicFactory: () => fakeClient("The user wants to carry chat context into story planning."),
    timeoutMs: 1_000,
  });

  assert.equal(result.wrote, true);
  assert.equal(result.fallback, false);
  assert.equal(result.error, null);
  assert.ok(result.path);

  const context = readFileSync(result.path!, "utf8");
  assert.ok(context.startsWith("## Chat context ("), "has dated header");
  assert.ok(context.includes("The user promoted this chat"), "has lead-in sentence");
  assert.ok(context.includes("The user wants to carry chat context"), "has summary body");

  const state = readFileSync(join(worktree, ".harness", "state.md"), "utf8");
  assert.ok(state.includes(POINTER), "state.md has the pointer");

  // Second call: pointer must not duplicate.
  const second = await carryChatContext({
    paseo,
    sourceAgentId: "agent-1",
    worktree,
    apiKey: "test-key",
    anthropicFactory: () => fakeClient("Another summary."),
    timeoutMs: 1_000,
  });
  assert.equal(second.wrote, true);
  const stateAfter = readFileSync(join(worktree, ".harness", "state.md"), "utf8");
  const matches = stateAfter.split(POINTER).length - 1;
  assert.equal(matches, 1, "pointer appears exactly once after a second call");

  rmSync(worktree, { recursive: true, force: true });
});

test("carryChatContext falls back to raw prompts when the SDK throws", async () => {
  const worktree = tmp();
  const paseo = makePaseo([
    { item: { type: "user_message", text: "first ask" } },
    { item: { type: "assistant_message", text: "answer" } },
    { item: { type: "user_message", text: "follow-up ask" } },
  ]);

  const result = await carryChatContext({
    paseo,
    sourceAgentId: "agent-1",
    worktree,
    apiKey: "test-key",
    anthropicFactory: () => throwingClient("rate limited"),
    timeoutMs: 1_000,
  });

  assert.equal(result.wrote, true);
  assert.equal(result.fallback, true);
  assert.equal(result.error, "rate limited");

  const context = readFileSync(result.path!, "utf8");
  assert.ok(context.includes("first ask"));
  assert.ok(context.includes("follow-up ask"));

  rmSync(worktree, { recursive: true, force: true });
});

test("carryChatContext falls back to raw prompts when ANTHROPIC_API_KEY is missing", async () => {
  const worktree = tmp();
  const paseo = makePaseo([{ item: { type: "user_message", text: "a question" } }]);

  const result = await carryChatContext({
    paseo,
    sourceAgentId: "agent-1",
    worktree,
    apiKey: null,
    anthropicFactory: () => {
      throw new Error("factory must not be called when no api key");
    },
  });

  assert.equal(result.wrote, true);
  assert.equal(result.fallback, true);
  assert.equal(result.error, null);
  const context = readFileSync(result.path!, "utf8");
  assert.ok(context.includes("a question"));

  rmSync(worktree, { recursive: true, force: true });
});

test("carryChatContext returns {wrote: false} when sourceAgentId is null", async () => {
  const result = await carryChatContext({
    paseo: makePaseo([]),
    sourceAgentId: null,
    worktree: "/does/not/matter",
    apiKey: "test-key",
    anthropicFactory: () => {
      throw new Error("factory must not be called");
    },
  });
  assert.deepEqual(result, { wrote: false, path: null, fallback: false, error: null });
});

test("carryChatContext never throws when the timeline refetch rejects", async () => {
  const worktree = tmp();
  const paseo: TimelinePort = {
    agents: {
      ref: () => ({
        timeline: {
          refetch: async () => {
            throw new Error("paseo unreachable");
          },
        },
      }),
    },
  };
  const result = await carryChatContext({
    paseo,
    sourceAgentId: "agent-1",
    worktree,
    apiKey: "test-key",
    anthropicFactory: () => fakeClient("ignored"),
  });
  assert.equal(result.wrote, false);
  assert.equal(result.error, "paseo unreachable");
  rmSync(worktree, { recursive: true, force: true });
});
