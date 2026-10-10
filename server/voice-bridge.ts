import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";

type AgentPermissionRequest = PluginLifecycleEvents["agent.permission_requested"]["request"];
type AgentPermissionResponse = PluginLifecycleEvents["agent.permission_resolved"]["resolution"];
type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];

// Voice bridge: a phone (Tasker) asks for the oldest waiting item, speaks it with Android text to
// speech, listens, and posts the reply back. An item is a blocked permission (ask) or the last
// message of an agent the phone is talking to (reply). The user ends each message with "roger".
// Off unless a token is in the Keychain; every call must carry it as a bearer token.

export type VoiceAsk = {
  id: string;
  agentId: string;
  text: string;
  risky: boolean;
  allowActionId?: string;
};

// An agent's latest finished message, queued only for agents the phone follows.
export type VoiceReply = { id: string; agentId: string; text: string };

export type VoiceItem = ({ kind: "ask" } & VoiceAsk) | ({ kind: "reply" } & VoiceReply);

export type VoiceDecision =
  | { kind: "respond"; response: AgentPermissionResponse; said: string }
  | { kind: "refuse"; said: string };

export type VoicePort = {
  respond(agentId: string, requestId: string, response: AgentPermissionResponse): Promise<void>;
  send(agentId: string, text: string): Promise<void>;
};

const RISKY = [
  /\bgit\s+push\b/,
  /--force\b|\s-f\b.*\bpush\b/,
  /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b/,
  /\bgh\s+pr\s+merge\b/,
  /\bnpm\s+publish\b/,
  /\bsudo\b/,
  /\bdrop\s+(table|database)\b/i,
  /\bdeploy\b/,
  /\|\s*(ba|z)?sh\b/,
];

const YES = new Set(["yes", "yeah", "yep", "sure", "ok", "okay", "allow", "approve", "approved", "go ahead", "do it"]);
const NO = new Set(["no", "nope", "deny", "stop", "cancel", "dont", "do not"]);
const CONFIRM = new Set(["confirm", "confirmed", "confirm it", "yes confirm", "confirm allow"]);

const MAX_SPOKEN = 160;
const MAX_REPLY = 600;

function commandOf(request: AgentPermissionRequest): string {
  const command = request.input?.command;
  return typeof command === "string" ? command : "";
}

function questionOf(request: AgentPermissionRequest): string {
  const questions = request.input?.questions;
  if (Array.isArray(questions)) {
    const first = questions[0] as { question?: unknown } | undefined;
    if (typeof first?.question === "string") return first.question;
  }
  return request.description ?? "";
}

function clip(text: string, max = MAX_SPOKEN): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// A mode change can turn approvals off for the whole session, so it's treated like a risky command.
export function isRisky(request: AgentPermissionRequest): boolean {
  if (request.kind === "mode") return true;
  const command = commandOf(request);
  return RISKY.some((pattern) => pattern.test(command));
}

export function spokenAsk(agentTitle: string | null, request: AgentPermissionRequest, risky: boolean): string {
  const who = agentTitle?.trim() || "An agent";
  const what = request.title || request.name;
  if (request.kind === "question") {
    return `${who} asks: ${clip(questionOf(request) || what)}. Say your answer.`;
  }
  const command = commandOf(request);
  const detail = command ? ` Command: ${clip(command)}.` : "";
  const prompt = risky ? "This one is risky. Say confirm to approve, or no." : "Say yes, no, or what to do instead.";
  return `${who} wants: ${clip(what)}.${detail} ${prompt}`;
}

// Markdown read aloud is noise: links keep their label, emphasis, heading and code marks go.
export function spokenReply(agentTitle: string | null, text: string): string {
  const who = agentTitle?.trim() || "An agent";
  const plain = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*#`~]/g, "");
  return `${who} says: ${clip(plain, MAX_REPLY)}`;
}

export function lastAssistantText(timeline: TurnEnded["timeline"]): string {
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const item = timeline[i];
    if (item.type === "assistant_message" && item.text.trim()) return item.text;
  }
  return "";
}

// "roger" closes a spoken message. Returns the text before it, or null when it's absent.
export function beforeRoger(reply: string): string | null {
  const match = /^([\s\S]*?)\W*\broger\W*$/i.exec(reply);
  return match ? match[1].trim() : null;
}

function normalise(reply: string): string {
  return reply
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// A bare yes or no with nothing waiting answers nothing; it must not reach an agent as a message.
function isVerdict(reply: string): boolean {
  const words = normalise(reply);
  return YES.has(words) || NO.has(words) || CONFIRM.has(words);
}

// Only a whole short reply counts as yes or no, so "no, use pnpm" reaches the agent as an instruction.
export function interpretReply(reply: string, ask: VoiceAsk): VoiceDecision {
  const words = normalise(reply);
  if (!words) return { kind: "refuse", said: "I didn't catch that." };
  const allow: AgentPermissionResponse = ask.allowActionId
    ? { behavior: "allow", selectedActionId: ask.allowActionId }
    : { behavior: "allow" };
  if (CONFIRM.has(words)) return { kind: "respond", response: allow, said: "Approved." };
  if (YES.has(words)) {
    return ask.risky
      ? { kind: "refuse", said: "That one is risky. Say confirm to approve, or no." }
      : { kind: "respond", response: allow, said: "Approved." };
  }
  if (NO.has(words)) return { kind: "respond", response: { behavior: "deny", message: "Denied by voice." }, said: "Denied." };
  return {
    kind: "respond",
    response: { behavior: "deny", message: `The user answered by voice: ${reply.trim()}` },
    said: "Sent to the agent.",
  };
}

const replyId = (agentId: string) => `reply:${agentId}`;

export type VoiceAnswer = { said: string } | { listen: true };

export function createVoiceBridge(port: VoicePort) {
  // Insertion order is arrival order, so the first entry is the oldest item.
  const items = new Map<string, VoiceItem>();
  // Agents the phone has answered; only they get their replies read out.
  const followed = new Set<string>();
  let lastFollowed: string | null = null;
  // Held chunks per item id ("" for none) until a chunk ends with "roger".
  const held = new Map<string, string[]>();
  const follow = (agentId: string) => {
    followed.add(agentId);
    lastFollowed = agentId;
  };
  const sendTo = async (agentId: string, text: string): Promise<{ said: string }> => {
    if (!text.trim()) return { said: "I didn't catch that." };
    await port.send(agentId, text.trim());
    follow(agentId);
    return { said: "Sent." };
  };
  const apply = async (reply: string, id?: string): Promise<{ said: string } | null> => {
    const item = id ? items.get(id) : items.values().next().value;
    if (!item) return !id && lastFollowed && !isVerdict(reply) ? sendTo(lastFollowed, reply) : null;
    if (item.kind === "reply") {
      if (!reply.trim()) return { said: "I didn't catch that." };
      const result = await sendTo(item.agentId, reply);
      items.delete(item.id);
      return result;
    }
    const decision = interpretReply(reply, item);
    if (decision.kind === "refuse") return { said: decision.said };
    await port.respond(item.agentId, item.id, decision.response);
    items.delete(item.id);
    follow(item.agentId);
    return { said: decision.said };
  };
  return {
    onRequested(agent: { id: string; title: string | null }, request: AgentPermissionRequest) {
      const risky = isRisky(request);
      const allowAction = request.actions?.find((action) => action.behavior === "allow" && action.variant === "primary")
        ?? request.actions?.find((action) => action.behavior === "allow");
      items.set(request.id, {
        kind: "ask",
        id: request.id,
        agentId: agent.id,
        text: spokenAsk(agent.title, request, risky),
        risky,
        ...(allowAction ? { allowActionId: allowAction.id } : {}),
      });
    },
    onResolved(requestId: string) {
      items.delete(requestId);
    },
    // A newer reply replaces the older one and moves to the back of the queue.
    onTurnEnded(event: Pick<TurnEnded, "agent" | "outcome" | "timeline">) {
      if (event.outcome.kind !== "completed" || !followed.has(event.agent.id)) return;
      const text = lastAssistantText(event.timeline);
      if (!text) return;
      const id = replyId(event.agent.id);
      items.delete(id);
      items.set(id, { kind: "reply", id, agentId: event.agent.id, text: spokenReply(event.agent.title, text) });
    },
    // A new turn means the user answered elsewhere, so the old reply is stale.
    onTurnStarted(agentId: string) {
      items.delete(replyId(agentId));
    },
    next(): VoiceItem | null {
      return items.values().next().value ?? null;
    },
    // With hold, chunks wait until one ends in "roger"; until then the phone keeps listening.
    async answer(reply: string, id?: string, hold = false): Promise<VoiceAnswer | null> {
      const message = beforeRoger(reply);
      if (!hold) return apply(message ?? reply, id);
      const key = id ?? "";
      const chunks = held.get(key) ?? [];
      if (message === null) {
        if (reply.trim()) held.set(key, [...chunks, reply.trim()]);
        return { listen: true };
      }
      held.delete(key);
      const whole = [...chunks, message].filter(Boolean).join(" ");
      return whole ? apply(whole, id) : { said: "I didn't catch that." };
    },
  };
}

export type VoiceBridge = ReturnType<typeof createVoiceBridge>;

export type VoiceHttpResult = { status: number; body?: unknown };

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

// GET /voice/next → the oldest item, or 204. POST /voice/answer {id?, reply, hold?} → { said } to
// speak back, or { listen: true } while a held message waits for "roger".
export async function handleVoiceRequest(
  bridge: VoiceBridge,
  token: string,
  request: { method: string; path: string; authorization?: string; body: string },
): Promise<VoiceHttpResult> {
  if (!token || !tokenMatches(request.authorization, token)) return { status: 401 };
  if (request.method === "GET" && request.path === "/voice/next") {
    const item = bridge.next();
    return item ? { status: 200, body: { id: item.id, kind: item.kind, text: item.text } } : { status: 204 };
  }
  if (request.method === "POST" && request.path === "/voice/answer") {
    let parsed: { id?: unknown; reply?: unknown; hold?: unknown };
    try {
      parsed = JSON.parse(request.body) as typeof parsed;
    } catch {
      return { status: 400, body: { error: "Body must be JSON." } };
    }
    if (typeof parsed.reply !== "string") return { status: 400, body: { error: "reply is required." } };
    const id = typeof parsed.id === "string" && parsed.id ? parsed.id : undefined;
    const result = await bridge.answer(parsed.reply, id, parsed.hold === true);
    return result ? { status: 200, body: result } : { status: 404, body: { said: "Nothing is waiting." } };
  }
  return { status: 404 };
}

export const VOICE_PORT = 4777;
const MAX_BODY = 4_096;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export function startVoiceServer(bridge: VoiceBridge, options: { host: string; port: number; token: string }) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let result: VoiceHttpResult;
      try {
        result = await handleVoiceRequest(bridge, options.token, {
          method: req.method ?? "GET",
          path: (req.url ?? "/").split("?")[0],
          authorization: req.headers.authorization,
          body: req.method === "POST" ? await readBody(req) : "",
        });
      } catch (error) {
        console.warn("orchestrator: voice request failed", error instanceof Error ? error.message : error);
        result = { status: 500, body: { said: "Something went wrong." } };
      }
      res.writeHead(result.status, result.body === undefined ? {} : { "content-type": "application/json" });
      res.end(result.body === undefined ? undefined : JSON.stringify(result.body));
    })();
  });
  server.on("error", (error) => console.warn("orchestrator: voice server error", error.message));
  server.listen(options.port, options.host);
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}
