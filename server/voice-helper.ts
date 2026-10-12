import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { VOICE_HELPER_SYSTEM_PROMPT, helperPrompt, parseHelperReply } from "../shared/voice-interpreter";
import type { InterpretResult, VoiceSession } from "../shared/voice-loop";
import { withMcpScope } from "./mcp-scope";

// The Voice helper's agent lifecycle (see CONTEXT.md, "Voice helper"): one Haiku agent per voice-on
// period, created with MCP scope "none" and no built-in tools, reused, and archived on stop. It talks
// to Paseo only through the ports, so tests use fakes.

export const VOICE_HELPER_MODEL = "claude/claude-haiku-4-5";
export const VOICE_HELPER_KIND = "voice-helper";

// Claude provider options are strict (allowedTools, disallowedTools, extraArgs, sandbox, settings...);
// none is a "no tools" switch, but extraArgs passes `--tools ""` to Claude Code, which disables every
// built-in tool. Not yet run against the daemon (see Evidence); a permission request is a failure anyway.
export const NO_TOOLS_OPTIONS = { extraArgs: { tools: "" } };

export type VoiceHelperSpec = {
  provider: typeof VOICE_HELPER_MODEL;
  systemPrompt: string;
  options: typeof NO_TOOLS_OPTIONS;
  cwd: string;
  title: string;
  labels: { kind: typeof VOICE_HELPER_KIND };
};

export type RecentMessage = { role: "user" | "assistant"; text: string };

export type VoiceHelperPorts = {
  cwd: string;
  createAgent(spec: VoiceHelperSpec): Promise<{ id: string }>;
  archive(agentId: string): Promise<void>;
  /** The target session's latest user and assistant messages, oldest first. */
  recentMessages(sessionId: string): Promise<RecentMessage[]>;
  /** One turn on the helper, with Paseo's default send. `status` is the run status. */
  run(agentId: string, prompt: string, timeoutMs: number): Promise<{ status: string; lastMessage: string | null }>;
};

// A little over the client's 3 s fallback, so a late answer is dropped by the client, not cut here.
export const INTERPRET_TIMEOUT_MS = 5000;
const RECENT_FETCH = 4;

export function createVoiceHelper(ports: VoiceHelperPorts) {
  let id: string | null = null;
  // The in-flight create, so concurrent starts share one agent.
  let starting: Promise<void> | null = null;

  function start(): Promise<void> {
    if (id) {
      return Promise.resolve();
    }
    starting ??= withMcpScope(ports.cwd, "none", () =>
      ports.createAgent({
        provider: VOICE_HELPER_MODEL,
        systemPrompt: VOICE_HELPER_SYSTEM_PROMPT,
        options: NO_TOOLS_OPTIONS,
        cwd: ports.cwd,
        title: "Voice helper",
        labels: { kind: VOICE_HELPER_KIND },
      }),
    )
      .then((agent) => {
        id = agent.id;
      })
      .finally(() => {
        starting = null;
      });
    return starting;
  }

  async function stop() {
    // A start still in flight finishes first, so its agent is archived rather than leaked.
    await starting?.catch(() => {});
    const agentId = id;
    id = null;
    if (agentId) {
      await ports.archive(agentId);
    }
  }

  // Throws on anything but a clean idle turn, so the client falls back to pass-through.
  async function interpret(input: { transcript: string; sessionId: string; sessions: VoiceSession[] }): Promise<InterpretResult> {
    const agentId = id;
    if (!agentId) {
      throw new Error("voice helper not started");
    }
    const recent = (await ports.recentMessages(input.sessionId)).slice(-RECENT_FETCH);
    const targetTitle = input.sessions.find((s) => s.id === input.sessionId)?.name ?? null;
    const prompt = helperPrompt({ transcript: input.transcript, targetTitle, recent, sessions: input.sessions });
    const run = await ports.run(agentId, prompt, INTERPRET_TIMEOUT_MS);
    if (run.status !== "idle") {
      throw new Error(`voice helper run ended ${run.status}`);
    }
    return parseHelperReply(run.lastMessage, input.sessions);
  }

  return { start, stop, interpret, agentId: () => id };
}

type PaseoApi = PluginHandlerContext["paseo"];

// A neutral folder owned by the plugin (same ~/.orchestrator home as the telemetry and loop registry),
// so the helper's Claude session never sits in a project and reads none of its CLAUDE.md.
export const VOICE_HELPER_CWD = join(homedir(), ".orchestrator", "voice-helper");
const MESSAGE_CHARS = 300;

/** The real ports over Paseo. Covered by typecheck only; the daemon is not faked here. */
export function paseoVoiceHelperPorts(paseo: PaseoApi, cwd: string = VOICE_HELPER_CWD): VoiceHelperPorts {
  return {
    cwd,
    createAgent: async (spec) => {
      const agent = await paseo.agents.create({
        config: { provider: spec.provider, systemPrompt: spec.systemPrompt, options: spec.options },
        cwd: spec.cwd,
        title: spec.title,
        labels: spec.labels,
      });
      return { id: agent.id };
    },
    archive: async (agentId) => {
      await paseo.agents.ref(agentId).archive();
    },
    run: async (agentId, prompt, timeoutMs) => {
      const result = await paseo.agents.ref(agentId).run(prompt, { timeoutMs });
      return { status: result.status, lastMessage: result.lastMessage };
    },
    recentMessages: async (sessionId) => {
      const page = await paseo.agents.ref(sessionId).timeline.refetch({ direction: "tail", limit: 30, projection: "projected" });
      if (page.error) {
        return [];
      }
      const messages: RecentMessage[] = [];
      for (const entry of page.entries) {
        const item = entry.item as { type: string; text?: string };
        if ((item.type === "user_message" || item.type === "assistant_message") && item.text) {
          messages.push({ role: item.type === "user_message" ? "user" : "assistant", text: item.text.slice(0, MESSAGE_CHARS) });
        }
      }
      return messages.slice(-RECENT_FETCH);
    },
  };
}
