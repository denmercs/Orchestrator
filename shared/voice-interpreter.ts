import { withoutName, type InterpretResult, type VoiceSession } from "./voice-loop";

const DROP: InterpretResult = { type: "drop" };

const unfence = (reply: string): string => {
  const text = reply.trim();
  const fenced = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```$/.exec(text);
  return fenced ? fenced[1].trim() : text;
};

const words = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

/** Reads the helper's one-line JSON answer; anything malformed or unknown is a drop. */
export function parseHelperReply(reply: string | null, sessions: VoiceSession[]): InterpretResult {
  if (!reply) return DROP;
  let value: unknown;
  try {
    value = JSON.parse(unfence(reply));
  } catch {
    return DROP;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return DROP;
  const { action, text, session } = value as Record<string, unknown>;
  if (action === "drop") return DROP;
  if (action === "send" || action === "confirm") {
    const said = words(text);
    return said ? { type: action, text: said } : DROP;
  }
  if (action === "switch") {
    const wanted = words(session)?.trim().toLowerCase();
    const found = wanted ? sessions.find((s) => s.name.trim().toLowerCase() === wanted) : undefined;
    return found ? { type: "switch", name: found.name } : DROP;
  }
  return DROP;
}

export type InterpretContext = {
  transcript: string;
  targetTitle: string | null;
  recent: { role: "user" | "assistant"; text: string }[];
  sessions: VoiceSession[];
};

/** `ctx` is optional so pass-through can work from the text alone. */
export type Interpreter = { interpret(text: string, ctx?: InterpretContext): Promise<InterpretResult> };

export const passThrough: Interpreter = { interpret: async (text) => ({ type: "send", text }) };

/** Pass-through without a leading "Jarvis," (or "hey Jarvis"): Jarvis's default, and its fallback behind a helper. */
export const namelessPassThrough: Interpreter = { interpret: async (text) => ({ type: "send", text: withoutName(text) }) };

export const VOICE_VOCABULARY = ["merge", "Orchestrator", "Paseo", "Jarvis"];

const RECENT_LIMIT = 4;
const RECENT_CHARS = 300;

/** The per-utterance message sent to the helper. */
export function helperPrompt(ctx: InterpretContext): string {
  const recent = ctx.recent.slice(-RECENT_LIMIT).map((m) => `${m.role}: ${m.text.slice(0, RECENT_CHARS)}`);
  return [
    `Transcript: ${ctx.transcript}`,
    `Target session title: ${ctx.targetTitle ?? "(none)"}`,
    `Vocabulary: ${VOICE_VOCABULARY.join(", ")}; story ids look like S1, S3.`,
    `Session names: ${ctx.sessions.map((s) => s.name).join(", ") || "(none)"}`,
    `Recent messages:\n${recent.join("\n") || "(none)"}`,
  ].join("\n");
}

export const VOICE_HELPER_SYSTEM_PROMPT = `You clean up speech-to-text for a voice interface. Each message holds one transcript with context. Choose one action:
- "send": send the cleaned-up text to the target session. Fix mis-heard words using the vocabulary.
- "switch": the user wants another session; "session" is that session's name from the list.
- "drop": a fragment or noise that is not a request. Send nothing.

Reply with only that JSON, no prose and no code fence:
{"action":"send"|"switch"|"drop","text"?:...,"session"?:...}

Examples:
"run the tests in orchestra tour" -> {"action":"send","text":"run the tests in Orchestrator"}
"This day" (a fragment) -> {"action":"drop"}
"merge England" -> {"action":"send","text":"merge it"}
"switch to the review session" -> {"action":"switch","session":"<the session named like that>"}`;

export type InterpretOutcome = {
  result: InterpretResult;
  via: "helper" | "passThrough";
  reason?: "timeout" | "error";
};

export type FallbackOptions = {
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

/** Races the primary interpreter against a timeout; on a timeout or failure the fallback answers. */
export function withFallback(primary: Interpreter, fallback: Interpreter, opts: FallbackOptions = {}) {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  return {
    async interpret(text: string, ctx?: InterpretContext): Promise<InterpretOutcome> {
      let timer: unknown;
      const raced = new Promise<InterpretOutcome | "timeout" | "error">((resolve) => {
        timer = setTimer(() => resolve("timeout"), timeoutMs);
        let pending: Promise<InterpretResult>;
        try {
          pending = primary.interpret(text, ctx);
        } catch {
          resolve("error");
          return;
        }
        pending.then(
          (result) => resolve({ result, via: "helper" }),
          () => resolve("error"),
        );
      });
      const won = await raced;
      clearTimer(timer);
      if (typeof won !== "string") return won;
      return { result: await fallback.interpret(text, ctx), via: "passThrough", reason: won };
    },
  };
}
