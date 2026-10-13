// The Jarvis provider: a Paseo agent provider with no model behind it. A session on it, with Paseo voice
// mode on, hears you on the phone and hands each utterance to the Jarvis router, which steers the target
// session. Replies are spoken in the cloned Chatterbox voice when its worker is warm, else through the `paseo` MCP
// server's `speak` tool (Kokoro; only there while voice mode is on) and shown in the chat as assistant messages.
import { randomUUID } from "node:crypto";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderMcpServerConfig,
  ProviderPrompt,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { ROUTER_PROVIDER_ID } from "../shared/voice-loop";
import type { RouteResult } from "./jarvis-router";

export { ROUTER_PROVIDER_ID as JARVIS_PROVIDER_ID } from "../shared/voice-loop";
export const JARVIS_MODEL = "router";
// session.persistence is required: voice on/off reopens the session, and Paseo refuses to without a handle.
const CAPABILITIES = ["prompt.message", "session.persistence"] as const;
const PLUGIN_ID = "orchestrator";
const VOICE_LINE_KIND = "voice-line";
const SPEAK_TIMEOUT_MS = 90_000;
/** Jarvis counts as active for this long after the last prompt or line (the phone is the speaker then). */
export const JARVIS_ACTIVE_MS = 10 * 60 * 1000;

type Fetch = typeof fetch;
type Session = {
  routerId: string;
  mcpServers: Readonly<Record<string, ProviderMcpServerConfig>>;
  turnId: string | null;
  /** Aborts the open turn's steer if it hasn't gone out yet. */
  abort: AbortController | null;
  /** When this session last sent or received a line; 0 until the first prompt. */
  lastActiveAt: number;
  /** Callers of `say` waiting for the open turn to end. */
  idle: (() => void)[];
};

export type JarvisConnection = ProviderConnection & {
  /** True when a session with a `paseo` MCP server (voice mode on) was active in the last JARVIS_ACTIVE_MS. */
  isActive(now: number): boolean;
  /** Says a router's event lines out of turn (after any open turn ends); a line that can't be said is owed to its next words. */
  say(routerId: string, lines: string[]): Promise<void>;
};

export type JarvisProviderDeps = {
  route(routerId: string, text: string, signal?: AbortSignal): Promise<RouteResult>;
  /** Keeps a line Jarvis couldn't say, to say first at the router's next words. */
  owe?(routerId: string, lines: string[]): void;
  /** What was spoken has finished (or failed), so the router's loop leaves `speaking`. */
  playbackEnded?(routerId: string): void;
  /** Setting `voice.phoneAudio`: when true, lines go to the phone as `voice-line` items instead of `speak`. Default false. */
  phoneAudio?(): boolean;
  /** Speaks on the Mac through the Speaker; false means it could not, so Paseo's `speak` tool takes the line. */
  localSpeak?(text: string): Promise<boolean>;
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

export function createJarvisConnection(deps: JarvisProviderDeps): JarvisConnection {
  const fetchImpl = deps.fetch ?? fetch;
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, Session>();
  const emit = (event: ProviderEvent) => {
    for (const listener of listeners) listener(event);
  };
  // Emitted after send() returns, so the daemon has registered the request first.
  const later = (event: ProviderEvent) => setImmediate(() => emit(event));
  const release = (session: Session) => {
    if (session.turnId === null) for (const wake of session.idle.splice(0)) wake();
  };
  // The phone's timeline renderer plays this in the cloned voice; each line gets its own id so it plays once.
  const voiceLine = (sessionId: string, text: string) => {
    const lineId = randomUUID();
    emit({
      type: "timeline.item",
      sessionId,
      item: { id: lineId, type: "plugin", pluginId: PLUGIN_ID, kind: VOICE_LINE_KIND, version: 1, data: { lineId, text } },
    });
  };
  const live = (sessionId: string, turnId: string) => sessions.get(sessionId)?.turnId === turnId;
  const end = (sessionId: string, turnId: string, state: "completed" | "failed", error?: string) => {
    if (!live(sessionId, turnId)) return;
    const session = sessions.get(sessionId) as Session;
    session.turnId = null;
    session.abort = null;
    session.lastActiveAt = Date.now();
    emit({ type: "session.turn", sessionId, turnId, state, ...(error ? { error: { message: error } } : {}) });
    release(session);
  };

  async function runTurn(sessionId: string, prompt: ProviderPrompt, turnId: string, signal: AbortSignal) {
    const session = sessions.get(sessionId);
    if (!session) return;
    if (live(sessionId, turnId)) emit({ type: "session.turn", sessionId, turnId, state: "started" });
    const text = promptText(prompt);
    const spoken = spokenText(text);
    const result = await deps.route(session.routerId, spoken ?? text, signal);
    const reply = result.spoken.join(" ") || result.note || "";
    if (reply && live(sessionId, turnId)) {
      emit({ type: "timeline.item", sessionId, item: { id: `${turnId}-reply`, type: "assistant_message", text: reply } });
    }
    // Typed messages are answered in the chat only.
    if (spoken !== null && result.spoken.length && live(sessionId, turnId)) {
      const line = result.spoken.join(" ");
      if (deps.phoneAudio?.()) voiceLine(sessionId, line);
      else {
        const local = await deps.localSpeak?.(line).catch(() => false);
        if (!local) {
          await speak(session.mcpServers.paseo, line, fetchImpl).catch((error) =>
            console.warn("orchestrator: Jarvis could not speak", error instanceof Error ? error.message : error),
          );
        }
      }
      deps.playbackEnded?.(session.routerId);
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
        sessions.set(input.sessionId, { routerId, mcpServers: input.config.mcpServers, turnId: null, abort: null, lastActiveAt: 0, idle: [] });
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
        // A new prompt while a turn is open (you spoke again mid-speak) completes the earlier turn first, so
        // none is left running; its steer still goes out.
        const earlier = session.turnId;
        if (earlier) later({ type: "session.turn", sessionId: input.sessionId, turnId: earlier, state: "completed" });
        const turnId = randomUUID();
        const abort = new AbortController();
        session.turnId = turnId;
        session.abort = abort;
        session.lastActiveAt = Date.now();
        later({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "turn", turnId } });
        setImmediate(() => {
          runTurn(input.sessionId, input.prompt, turnId, abort.signal).catch((error) =>
            end(input.sessionId, turnId, "failed", error instanceof Error ? error.message : String(error)),
          );
        });
        return;
      }
      case "session.interrupt": {
        const session = sessions.get(input.sessionId);
        const turnId = session?.turnId;
        if (session && turnId) {
          // Stops the steer if it hasn't gone out; one already sent stays sent.
          session.abort?.abort();
          session.abort = null;
          session.turnId = null;
          release(session);
          later({ type: "session.turn", sessionId: input.sessionId, turnId, state: "canceled" });
        }
        later({ type: "request.completed", requestId: input.requestId });
        return;
      }
      case "session.close": {
        const closing = sessions.get(input.sessionId);
        sessions.delete(input.sessionId);
        if (closing) {
          closing.turnId = null;
          release(closing);
        }
        later({ type: "request.completed", requestId: input.requestId });
        later({ type: "session.closed", sessionId: input.sessionId });
        return;
      }
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
    async say(routerId, lines) {
      if (!lines.length) return;
      const target = () => [...sessions.values()].find((s) => s.routerId === routerId && s.mcpServers.paseo);
      let session = target();
      // Never over a turn's own reply: wait for the open turn to end.
      while (session?.turnId) {
        await new Promise<void>((resolve) => (session as Session).idle.push(resolve));
        session = target();
      }
      if (!session) {
        deps.owe?.(routerId, lines);
        return;
      }
      session.lastActiveAt = Date.now();
      if (deps.phoneAudio?.()) {
        const sessionId = [...sessions.entries()].find(([, s]) => s === session)?.[0] as string;
        for (const line of lines) voiceLine(sessionId, line);
        deps.playbackEnded?.(routerId);
        return;
      }
      try {
        await speak(session.mcpServers.paseo, lines.join(" "), fetchImpl);
      } catch (error) {
        console.warn("orchestrator: Jarvis could not speak", error instanceof Error ? error.message : error);
        deps.owe?.(routerId, lines);
      }
      deps.playbackEnded?.(routerId);
    },
    isActive(now) {
      for (const session of sessions.values()) {
        if (session.mcpServers.paseo && now - session.lastActiveAt < JARVIS_ACTIVE_MS) return true;
      }
      return false;
    },
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
    id: ROUTER_PROVIDER_ID,
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
