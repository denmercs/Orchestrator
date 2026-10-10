import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";

type AgentPermissionRequest = PluginLifecycleEvents["agent.permission_requested"]["request"];
type AgentPermissionResponse = PluginLifecycleEvents["agent.permission_resolved"]["resolution"];

// Voice bridge: a phone (Tasker) asks for the oldest blocked permission, speaks it with Android
// text to speech, listens, and posts the reply back. The bridge maps the reply onto the request.
// Off unless a token is in the Keychain; every call must carry it as a bearer token.

export type VoiceAsk = {
  id: string;
  agentId: string;
  text: string;
  risky: boolean;
  allowActionId?: string;
};

export type VoiceDecision =
  | { kind: "respond"; response: AgentPermissionResponse; said: string }
  | { kind: "refuse"; said: string };

export type VoicePort = {
  respond(agentId: string, requestId: string, response: AgentPermissionResponse): Promise<void>;
};

// A story PR at the merge gate (open, CI green). Its review is read out before "merge" can merge it.
export type MergeReady = { id: string; storyId: string; title: string; pr: number; cwd: string; review: string };

export type MergePort = {
  ready(): MergeReady[];
  // Checks the PR with GitHub again and merges it; `said` is the result or why it did not merge.
  merge(item: MergeReady): Promise<{ merged: boolean; said: string }>;
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

const MERGE = new Set(["merge", "merge it", "merge now", "yes merge"]);
const SKIP = new Set(["skip", "skip it", "no", "nope", "not now", "later", "wait"]);

const MAX_SPOKEN = 160;
// A skipped merge isn't offered again for an hour.
export const SKIP_MS = 60 * 60 * 1000;

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

export function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SPOKEN ? `${flat.slice(0, MAX_SPOKEN)}…` : flat;
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

function normalise(reply: string): string {
  return reply
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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

export function mergeAskText(item: MergeReady): string {
  return `${item.title}, PR ${item.pr}. CI is green. ${item.review} Say merge to merge it, or skip.`;
}

// Only "merge" merges a PR; yes and confirm don't, so a misheard approval can't merge anything.
export function interpretMergeReply(reply: string): "merge" | "skip" | { said: string } {
  const words = normalise(reply);
  if (!words) return { said: "I didn't catch that." };
  if (MERGE.has(words)) return "merge";
  if (SKIP.has(words)) return "skip";
  return { said: "Say merge to merge it, or skip." };
}

export function createVoiceBridge(port: VoicePort, merges?: MergePort, now: () => number = Date.now) {
  // Insertion order is arrival order, so the first entry is the oldest ask.
  const asks = new Map<string, VoiceAsk>();
  const skippedUntil = new Map<string, number>();
  // Merged or merging here; the loop marks the story merged on its next tick.
  const done = new Set<string>();
  const offered = (item: MergeReady) => !done.has(item.id) && (skippedUntil.get(item.id) ?? 0) <= now();
  async function answerMerge(merger: MergePort, item: MergeReady, reply: string) {
    const decision = interpretMergeReply(reply);
    if (typeof decision === "object") return decision;
    if (decision === "skip") {
      skippedUntil.set(item.id, now() + SKIP_MS);
      return { said: "Skipped." };
    }
    if (done.has(item.id)) return { said: `PR ${item.pr} is already merging.` };
    done.add(item.id);
    const result = await merger.merge(item).catch(() => ({ merged: false, said: `PR ${item.pr} did not merge.` }));
    if (!result.merged) done.delete(item.id);
    return { said: result.said };
  }
  return {
    onRequested(agent: { id: string; title: string | null }, request: AgentPermissionRequest) {
      const risky = isRisky(request);
      const allowAction = request.actions?.find((action) => action.behavior === "allow" && action.variant === "primary")
        ?? request.actions?.find((action) => action.behavior === "allow");
      asks.set(request.id, {
        id: request.id,
        agentId: agent.id,
        text: spokenAsk(agent.title, request, risky),
        risky,
        ...(allowAction ? { allowActionId: allowAction.id } : {}),
      });
    },
    onResolved(requestId: string) {
      asks.delete(requestId);
    },
    next(): VoiceAsk | null {
      return asks.values().next().value ?? null;
    },
    // What the phone reads next: a blocked agent first, then a PR waiting to merge.
    nextSpoken(): { id: string; text: string } | null {
      const ask = this.next();
      if (ask) return { id: ask.id, text: ask.text };
      const item = merges?.ready().find(offered);
      return item ? { id: item.id, text: mergeAskText(item) } : null;
    },
    async answer(reply: string, id?: string): Promise<{ said: string } | null> {
      const target = id ?? this.nextSpoken()?.id;
      const ask = target ? asks.get(target) : undefined;
      if (!ask) {
        const item = target ? merges?.ready().find((ready) => ready.id === target) : undefined;
        return merges && item ? answerMerge(merges, item, reply) : null;
      }
      const decision = interpretReply(reply, ask);
      if (decision.kind === "refuse") return { said: decision.said };
      await port.respond(ask.agentId, ask.id, decision.response);
      asks.delete(ask.id);
      return { said: decision.said };
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

// GET /voice/next → the oldest ask, or 204. POST /voice/answer {id?, reply} → { said } to speak back.
export async function handleVoiceRequest(
  bridge: VoiceBridge,
  token: string,
  request: { method: string; path: string; authorization?: string; body: string },
): Promise<VoiceHttpResult> {
  if (!token || !tokenMatches(request.authorization, token)) return { status: 401 };
  if (request.method === "GET" && request.path === "/voice/next") {
    const ask = bridge.nextSpoken();
    return ask ? { status: 200, body: ask } : { status: 204 };
  }
  if (request.method === "POST" && request.path === "/voice/answer") {
    let parsed: { id?: unknown; reply?: unknown };
    try {
      parsed = JSON.parse(request.body) as typeof parsed;
    } catch {
      return { status: 400, body: { error: "Body must be JSON." } };
    }
    if (typeof parsed.reply !== "string") return { status: 400, body: { error: "reply is required." } };
    const id = typeof parsed.id === "string" && parsed.id ? parsed.id : undefined;
    const result = await bridge.answer(parsed.reply, id);
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
