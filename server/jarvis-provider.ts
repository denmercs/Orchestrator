// The Jarvis provider: a Paseo agent provider with no model behind it. A session on it, with Paseo voice
// mode on, hears you on the phone and hands each utterance to the Jarvis router, which steers the target
// session. Replies are spoken through the `paseo` MCP server's `speak` tool (only there while voice mode
// is on) and shown in the chat as assistant messages.
import { randomUUID } from "node:crypto";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderMcpServerConfig,
  ProviderPrompt,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import type { RouteResult } from "./jarvis-router";

export const JARVIS_PROVIDER_ID = "jarvis";
export const JARVIS_MODEL = "router";
// session.persistence is required: voice on/off reopens the session, and Paseo refuses to without a handle.
const CAPABILITIES = ["prompt.message", "session.persistence"] as const;
const SPEAK_TIMEOUT_MS = 90_000;

type Fetch = typeof fetch;
type Session = { routerId: string; mcpServers: Readonly<Record<string, ProviderMcpServerConfig>>; turnId: string | null };

export type JarvisProviderDeps = {
  route(routerId: string, text: string): Promise<RouteResult>;
  fetch?: Fetch;
};

/** The prompt's text; a slash command comes back as typed. */
export function promptText(prompt: ProviderPrompt): string {
  if (prompt.input.type === "command") return `/${prompt.input.name} ${prompt.input.arguments}`.trim();
  return prompt.input.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** Paseo voice mode wraps what it heard in `<spoken-input>`; anything else was typed. */
export function spokenText(text: string): string | null {
  const match = /<spoken-input>\s*([\s\S]*?)\s*<\/spoken-input>/.exec(text);
  return match ? match[1] : null;
}

/** The persisted router id, or null when the handle is missing or not ours. */
export function routerIdOf(persistence: { data: unknown } | undefined): string | null {
  const data = persistence?.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const id = (data as Record<string, unknown>).routerId;
  return typeof id === "string" && id ? id : null;
}

/**
 * Calls the `speak` tool on Paseo's HTTP MCP server: one stateless JSON-RPC POST (no initialize needed).
 * The reply is plain JSON or SSE `data:` lines. Resolves once playback ends; throws on any failure.
 */
export async function speak(server: ProviderMcpServerConfig | undefined, text: string, fetchImpl: Fetch = fetch): Promise<void> {
  if (!server || server.type === "stdio") throw new Error("no HTTP paseo MCP server");
  const response = await fetchImpl(server.url, {
    method: "POST",
    headers: {
      ...(server.headers ?? {}),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name: "speak", arguments: { text } } }),
    signal: AbortSignal.timeout(SPEAK_TIMEOUT_MS),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`speak: HTTP ${response.status}`);
  const json = response.headers.get("content-type")?.includes("text/event-stream")
    ? body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .pop()
    : body;
  const message = JSON.parse(json || "{}") as { result?: { isError?: boolean }; error?: { message?: string } };
  if (message.error) throw new Error(`speak: ${message.error.message ?? "error"}`);
  if (message.result?.isError) throw new Error("speak: the tool failed (is voice mode on?)");
}

export function createJarvisConnection(deps: JarvisProviderDeps): ProviderConnection {
  const fetchImpl = deps.fetch ?? fetch;
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, Session>();
  const emit = (event: ProviderEvent) => {
    for (const listener of listeners) listener(event);
  };
  // Emitted after send() returns, so the daemon has registered the request first.
  const later = (event: ProviderEvent) => setImmediate(() => emit(event));
  const live = (sessionId: string, turnId: string) => sessions.get(sessionId)?.turnId === turnId;
  const end = (sessionId: string, turnId: string, state: "completed" | "failed", error?: string) => {
    if (!live(sessionId, turnId)) return;
    (sessions.get(sessionId) as Session).turnId = null;
    emit({ type: "session.turn", sessionId, turnId, state, ...(error ? { error: { message: error } } : {}) });
  };

  async function runTurn(sessionId: string, prompt: ProviderPrompt, turnId: string) {
    const session = sessions.get(sessionId);
    if (!session) return;
    emit({ type: "session.turn", sessionId, turnId, state: "started" });
    const text = promptText(prompt);
    const spoken = spokenText(text);
    const result = await deps.route(session.routerId, spoken ?? text);
    const reply = result.spoken.join(" ") || result.note || "";
    if (reply && live(sessionId, turnId)) {
      emit({ type: "timeline.item", sessionId, item: { id: `${turnId}-reply`, type: "assistant_message", text: reply } });
    }
    // Typed messages are answered in the chat only.
    if (spoken !== null && result.spoken.length && live(sessionId, turnId)) {
      await speak(session.mcpServers.paseo, result.spoken.join(" "), fetchImpl).catch((error) =>
        console.warn("orchestrator: Jarvis could not speak", error instanceof Error ? error.message : error),
      );
    }
    end(sessionId, turnId, "completed");
  }

  async function send(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog":
        later({
          type: "catalog",
          requestId: input.requestId,
          catalog: { models: [{ id: JARVIS_MODEL, label: "Router", isDefault: true }], modes: [], defaultModel: JARVIS_MODEL },
        });
        return;
      case "sessions":
        later({ type: "sessions", requestId: input.requestId, sessions: [] });
        return;
      case "session.open": {
        const routerId = routerIdOf(input.persistence) ?? randomUUID();
        sessions.set(input.sessionId, { routerId, mcpServers: input.config.mcpServers, turnId: null });
        later({
          type: "session.opened",
          requestId: input.requestId,
          sessionId: input.sessionId,
          capabilities: [...CAPABILITIES],
          restoration: "core",
          // Without a handle Paseo can't reopen the session (voice on/off does), and the id keeps the router's state.
          persistence: { version: 1, data: { routerId } },
          cwd: input.config.cwd,
        });
        later({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
        return;
      }
      case "session.prompt": {
        const session = sessions.get(input.sessionId);
        if (!session) {
          later({
            type: "session.prompt_result",
            sessionId: input.sessionId,
            clientMessageId: input.prompt.clientMessageId,
            result: { type: "failed", error: { message: "This Jarvis session is not open." } },
          });
          return;
        }
        const turnId = randomUUID();
        session.turnId = turnId;
        later({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "turn", turnId } });
        setImmediate(() => {
          runTurn(input.sessionId, input.prompt, turnId).catch((error) =>
            end(input.sessionId, turnId, "failed", error instanceof Error ? error.message : String(error)),
          );
        });
        return;
      }
      case "session.interrupt": {
        const session = sessions.get(input.sessionId);
        const turnId = session?.turnId;
        if (session && turnId) {
          session.turnId = null;
          later({ type: "session.turn", sessionId: input.sessionId, turnId, state: "canceled" });
        }
        later({ type: "request.completed", requestId: input.requestId });
        return;
      }
      case "session.close":
        sessions.delete(input.sessionId);
        later({ type: "request.completed", requestId: input.requestId });
        later({ type: "session.closed", sessionId: input.sessionId });
        return;
      case "session.permission":
        return;
      default:
        later({ type: "request.completed", requestId: input.requestId });
    }
  }

  return {
    version: 1,
    capabilities: [...CAPABILITIES],
    send,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      listeners.clear();
      sessions.clear();
    },
  };
}

export function createJarvisProvider(deps: JarvisProviderDeps): ProviderRegistration {
  return {
    id: JARVIS_PROVIDER_ID,
    label: "Jarvis",
    description: "Talk to your sessions hands-free with Paseo voice mode.",
    async status() {
      return { available: true };
    },
    async connect() {
      return createJarvisConnection(deps);
    },
  };
}
