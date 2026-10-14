import { SUMMARY_CAP, spokenLine } from "../shared/voice-lines";
import { VOICE_HELPER_KIND } from "../shared/voice-loop";
import { withMcpScope } from "./mcp-scope";
import { NO_TOOLS_OPTIONS, VOICE_HELPER_MODEL, type VoiceHelperPorts } from "./voice-helper";

// The reply summariser (see CONTEXT.md, "Voice helper"): a second small Haiku agent next to the interpret helper,
// same ports, same cwd and kind label (so it is never a target and never replies into the loop), its own prompt.
// It talks to Paseo only through the ports, so tests use fakes.

export const SUMMARY_FALLBACK_MS = 3000;
export const SUMMARY_PROMPT_CHARS = 4000;
// A run can outlive the 3 s we waited; it is cut here so the agent frees up.
const SUMMARY_RUN_TIMEOUT_MS = 5000;

export const REPLY_SUMMARY_SYSTEM_PROMPT = `You turn one assistant reply into a short spoken summary. The user message is the reply text, nothing else.
Write two or three plain sentences, at most ${SUMMARY_CAP} characters, that will be read aloud.
Keep every question, numbered choice and blocker word for word.
No markdown, no code, no lists, no preamble. Say only the summary.`;

export function createReplySummary(ports: VoiceHelperPorts, opts: { timeoutMs?: number } = {}) {
  const timeoutMs = opts.timeoutMs ?? SUMMARY_FALLBACK_MS;
  let id: string | null = null;
  let starting: Promise<void> | null = null;
  let running = false;

  function start(): Promise<void> {
    if (id) return Promise.resolve();
    starting ??= withMcpScope(ports.cwd, "none", () =>
      ports.createAgent({
        provider: VOICE_HELPER_MODEL,
        systemPrompt: REPLY_SUMMARY_SYSTEM_PROMPT,
        options: NO_TOOLS_OPTIONS,
        cwd: ports.cwd,
        title: "Reply summary",
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
    await starting?.catch(() => {});
    const agentId = id;
    id = null;
    if (agentId) await ports.archive(agentId).catch(() => {});
  }

  /** The summary, or null at once when it can't help: not started, busy, short reply, error, or past the limit. */
  async function summarize(text: string): Promise<string | null> {
    const agentId = id;
    if (!agentId || running) return null;
    // Already short enough to say as it is.
    if (spokenLine(text, "full").length <= SUMMARY_CAP) return null;
    const prompt = withoutFences(text).slice(0, SUMMARY_PROMPT_CHARS);
    running = true;
    const run = ports.run(agentId, prompt, SUMMARY_RUN_TIMEOUT_MS).then(
      (r) => (r.status === "idle" && r.lastMessage?.trim() ? r.lastMessage.trim() : null),
      () => null,
    );
    void run.then(() => (running = false));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      return await Promise.race([run, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  return { start, stop, summarize, agentId: () => id };
}

function withoutFences(text: string): string {
  let fenced = false;
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) kept.push(line);
  }
  return kept.join("\n").trim();
}
