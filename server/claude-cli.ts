// One-shot Claude Haiku calls through the Claude Code CLI the user is already signed into, so no API key is needed.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { MAX_TOKENS, MODEL } from "./corrections";

export type Ask = (system: string, prompt: string) => Promise<{ text: string; costUsd: number }>;
// Runs `claude` with these args and the prompt on stdin; resolves with stdout.
export type RunCli = (args: string[], input: string) => Promise<string>;

const TIMEOUT_MS = 120_000;

// No tools, MCP servers, settings, skills or saved session: one plain completion.
export const cliArgs = (system: string) => [
  "-p",
  "--model",
  MODEL,
  "--output-format",
  "json",
  "--system-prompt",
  system,
  "--tools",
  "",
  "--strict-mcp-config",
  "--setting-sources",
  "",
  "--disable-slash-commands",
  "--no-session-persistence",
];

// Caps the reply at MAX_TOKENS, so the cost cap's worst case holds, and turns thinking off.
export const CLI_ENV = { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(MAX_TOKENS), MAX_THINKING_TOKENS: "0" };

// Runs from the temp dir so no project CLAUDE.md is read.
export const runClaude: RunCli = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: tmpdir(), timeout: TIMEOUT_MS, env: { ...process.env, ...CLI_ENV } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => reject(new Error(`could not run the claude CLI: ${error.message}`)));
    child.on("close", (code) =>
      // A failed run can still print its JSON envelope, which carries the reason.
      code === 0 || stdout.trim() ? resolve(stdout) : reject(new Error(`claude CLI exited ${code}: ${stderr.slice(0, 300)}`)),
    );
    child.stdin.end(input);
  });

export function claudeCli(run: RunCli = runClaude): Ask {
  return async (system, prompt) => {
    const raw = await run(cliArgs(system), prompt);
    let reply: { result?: unknown; total_cost_usd?: unknown; is_error?: unknown };
    try {
      reply = JSON.parse(raw);
    } catch {
      throw new Error(`claude CLI output was not JSON: ${raw.slice(0, 300)}`);
    }
    const costUsd = typeof reply.total_cost_usd === "number" && Number.isFinite(reply.total_cost_usd) ? reply.total_cost_usd : 0;
    const text = typeof reply.result === "string" ? reply.result : "";
    if (reply.is_error) throw Object.assign(new Error(`claude CLI failed: ${text.slice(0, 300)}`), { costUsd });
    return { text, costUsd };
  };
}

// Whether the Claude Code CLI is installed and signed in (`claude auth status`). Never throws.
export async function claudeSignedIn(run: RunCli = runClaude): Promise<boolean> {
  try {
    return JSON.parse(await run(["auth", "status"], "")).loggedIn === true;
  } catch {
    return false;
  }
}
