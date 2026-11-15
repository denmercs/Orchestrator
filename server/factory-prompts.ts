import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { FactorySlice } from "../shared/factory";
import { readFactory, sliceDir, writeSliceState } from "./factory-layout";

// The part of a Paseo permission request the tick reads (`AgentPermissionRequest`): what the tool is and what it touches.
export type SeatPrompt = {
  id: string;
  name: string;
  kind: string;
  title?: string;
  input?: Record<string, unknown>;
  detail?: { type: string; command?: string; cwd?: string; filePath?: string; filePaths?: string[]; url?: string };
  actions?: { id: string; label: string; behavior: "allow" | "deny" }[];
};

export type PromptAnswer = { requestId: string; response: { behavior: "allow"; selectedActionId?: string } };

export type PromptVerdict = { allow: true } | { allow: false; why: string };

// Commands the tick never answers for a seat, whatever folder they run in: each reaches past the worktree (the remote, a
// container, the network, a global setting) or throws away uncommitted work.
const ESCALATE: [RegExp, string][] = [
  [/\bgit\s+push\b/, "pushes to the remote"],
  [/\bgit\s+(reset\s+--hard|clean\s+-\w*f|stash\b|restore\b)|\bgit\s+checkout\b[^;&|\n]*\s(--|\.|-f|--force)(\s|$)/, "can discard uncommitted work"],
  [/\bgit\s+config\s+--(global|system)\b/, "edits global git config"],
  [/\b(docker|podman)(\s+compose|-compose)?\s+(start|stop|restart|kill|rm|rmi|up|down|run|prune|system|volume|network)\b/, "starts, stops or removes containers"],
  [/\bwp-env\s+(start|stop|destroy|clean|reset|run)\b/, "starts or stops wp-env"],
  [/\bcolima\b/, "manages the container VM"],
  [/\b(npm|pnpm|yarn|bun)\s+(install|i|ci|add|update|upgrade|up)\b/, "installs packages from the network"],
  [/\b(npm|pnpm|yarn)\b[^;&|\n]*\s(-g|--global)(\s|$)/, "changes global packages"],
  [/\b(npm|pnpm|yarn)\s+config\s+(set|delete|edit)\b/, "edits package manager config"],
  [/\b(pip3?|pipx|uv\s+pip|gem|cargo|go|brew|apt(-get)?|port)\s+(install|upgrade|uninstall|remove)\b/, "installs or removes packages"],
  [/\bnpx\s+(-y|--yes|-p|--package)\b|\b(bunx|uvx)\b|\b(pnpm|yarn)\s+dlx\b/, "downloads and runs a package"],
  [/\b(sudo|doas)\b/, "runs as root"],
  [/\b(defaults\s+write|launchctl|crontab|systemctl)\b/, "edits system settings"],
  [/\bpaseo\s+(config|provider|daemon|plugin)\b/, "edits Paseo settings"],
];

// Absolute paths outside the scope that are still harmless to name in a command.
const HARMLESS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

const expand = (path: string) => (path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path);

const inside = (path: string, roots: string[]) =>
  roots.some((root) => {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });

// The folders a slice's seat may work in: its worktree, its own slice folder (for `proof.md`), the slice's `paths` and the
// manager's `paths`. `~` means the home folder; a relative entry is taken from the worktree.
export function promptScope(root: string, slice: FactorySlice): string[] {
  const { worktree, paths } = slice.state;
  const extra = [...paths, ...readFactory(root).manager.paths];
  return [worktree, sliceDir(root, slice.mission, slice.id), ...extra.map((path) => resolve(worktree, expand(path)))].filter(Boolean);
}

const text = (value: unknown) => (typeof value === "string" ? value : Array.isArray(value) ? value.filter((part) => typeof part === "string").join(" ") : "");

// The words of a command that name a path: absolute, home-relative or climbing out with `..`, with quotes, a `--flag=`
// prefix and a redirect stripped. A path built from a variable can't be checked, so it comes back as `$`.
function pathWords(command: string): string[] {
  return command
    .split(/[\s;&|()]+/)
    .map((word) => word.replace(/^[<>]+|^\d>+/, "").replace(/^['"]|['"]$/g, "").replace(/^--?[\w-]+=/, ""))
    .flatMap((word) => {
      if (word.includes("$") && word.includes("/")) return ["$"];
      return word.startsWith("/") || word.startsWith("~") || word.split("/").includes("..") ? [word] : [];
    });
}

// Whether a shell command stays in the scope: it runs there, every path it names is there, and it matches no ESCALATE rule.
function judgeCommand(command: string, cwd: string, roots: string[]): PromptVerdict {
  if (!command.trim()) return { allow: false, why: "an empty command" };
  if (!inside(cwd, roots)) return { allow: false, why: `runs in ${cwd}, outside the slice's folders` };
  for (const [pattern, why] of ESCALATE) if (pattern.test(command)) return { allow: false, why };
  // A local server (an E2E site) is fine to call; anything else is the network.
  if (/\b(curl|wget)\b/.test(command) && !(command.match(/\bhttps?:\/\/[^\s'"]+/g) ?? [""]).every((url) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)))
    return { allow: false, why: "reaches the network" };
  if (/`|\$\(/.test(command)) return { allow: false, why: "builds part of the command at run time" };
  for (const word of pathWords(command)) {
    if (word === "$") return { allow: false, why: "names a path built from a variable" };
    if (HARMLESS.has(word)) continue;
    const path = resolve(cwd, expand(word));
    if (!inside(path, roots)) return { allow: false, why: `touches ${path}, outside the slice's folders` };
    if (/\brm\b/.test(command) && roots.includes(path)) return { allow: false, why: `removes ${path} itself` };
  }
  return { allow: true };
}

// Whether a permission prompt is clearly the seat's own business: a tool call that only reads, edits or runs commands
// inside the scope, with nothing in ESCALATE. Plans, questions, mode changes, fetches and tools it can't read go to a human.
export function judgePrompt(prompt: SeatPrompt, cwd: string, roots: string[]): PromptVerdict {
  if (prompt.kind !== "tool") return { allow: false, why: `a ${prompt.kind} request` };
  const { detail, input = {} } = prompt;
  const command = detail?.type === "shell" ? detail.command ?? "" : text(input.command ?? input.cmd);
  const given = detail?.cwd || text(input.cwd ?? input.working_directory);
  if (detail?.type === "shell" || command) return judgeCommand(command, given ? resolve(cwd, expand(given)) : cwd, roots);
  if (detail?.type === "fetch" || input.url) return { allow: false, why: "reaches the network" };
  const files = [
    detail?.filePath,
    ...(detail?.filePaths ?? []),
    ...["file_path", "filePath", "path", "target_file", "notebook_path", "directory"].map((key) => text(input[key])),
  ].filter((file): file is string => Boolean(file));
  const known = detail ? ["read", "edit", "write", "search"].includes(detail.type) : /^(read|edit|write|multiedit|grep|glob|ls|search|find)/i.test(prompt.name);
  if (!known) return { allow: false, why: `a ${prompt.name} call the tick can't read` };
  for (const file of files) {
    const path = resolve(cwd, expand(file));
    if (!inside(path, roots)) return { allow: false, why: `touches ${path}, outside the slice's folders` };
  }
  return { allow: true };
}

// The one-time allow the tick answers with: the prompt's allow action that doesn't widen to "always", when it offers actions.
export function allowOnce(prompt: SeatPrompt): PromptAnswer {
  const allows = (prompt.actions ?? []).filter((action) => action.behavior === "allow");
  const once = allows.find((action) => !/always|session|remember|forever/i.test(`${action.id} ${action.label}`)) ?? allows[0];
  return { requestId: prompt.id, response: { behavior: "allow", ...(once ? { selectedActionId: once.id } : {}) } };
}

// One line naming what a prompt asks, for the manager and the digest.
export function promptLine(prompt: SeatPrompt): string {
  const { detail, input = {} } = prompt;
  const what = detail?.command ?? detail?.filePath ?? detail?.url ?? text(input.command ?? input.file_path ?? input.path ?? input.url);
  return `${prompt.title || prompt.name}${what && !(prompt.title ?? "").includes(what) ? `: ${what}` : ""}`.replace(/\s+/g, " ").slice(0, 160);
}

type Session = { pendingPermissions?: SeatPrompt[] | null } | null | undefined;
export type PromptPorts = {
  respond?: (answer: PromptAnswer) => Promise<unknown>;
  steer?: (line: string) => Promise<unknown>;
  now?: () => number;
};

const steered = async (steer: PromptPorts["steer"], line: string) =>
  Boolean(steer) && (await Promise.resolve().then(() => steer!(line)).catch(() => false)) !== false;

// A live seat that waits on a permission prompt: the tick answers a prompt in the slice's scope (`judgePrompt`) and tells the
// manager about the first one it won't answer, once, recorded as `prompt` in state.md. Once that one has waited
// `promptMinutes` the manager hears it is stalled, once more. `prompt_steered` is saved only when a steer was delivered, so an
// undelivered one is tried again next pass. No prompt left clears the fields.
export async function answerSeatPrompts(root: string, slice: FactorySlice, session: Session, ports: PromptPorts): Promise<void> {
  const { id, mission, state } = slice;
  const pending = session?.pendingPermissions ?? [];
  if (!pending.length && !state.prompt) return;
  const roots = promptScope(root, slice);
  const waiting: { prompt: SeatPrompt; why: string }[] = [];
  for (const prompt of pending) {
    const verdict = judgePrompt(prompt, state.worktree, roots);
    if (!verdict.allow) {
      waiting.push({ prompt, why: verdict.why });
      continue;
    }
    if (!ports.respond) {
      waiting.push({ prompt, why: "this handle can't answer prompts" });
      continue;
    }
    try {
      await ports.respond(allowOnce(prompt));
    } catch (error) {
      waiting.push({ prompt, why: `the auto-approve failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  const first = waiting[0];
  if (!first) {
    if (state.prompt) writeSliceState(root, mission, id, { prompt: null, prompt_what: null, prompt_since: null, prompt_steered: null });
    return;
  }
  const now = ports.now?.() ?? Date.now();
  const seat = state.seat || "seat";
  const what = `${promptLine(first.prompt)} (${first.why})`;
  if (first.prompt.id !== state.prompt) {
    writeSliceState(root, mission, id, { prompt: first.prompt.id, prompt_what: what, prompt_since: new Date(now).toISOString(), prompt_steered: null });
    const line = `Slice ${id}'s ${seat} seat waits on a permission prompt the tick won't answer: ${what}. Answer it in session ${state.agent}.`;
    if (await steered(ports.steer, line)) writeSliceState(root, mission, id, { prompt_steered: "asked" });
    return;
  }
  if (!state.prompt_steered) {
    const line = `Slice ${id}'s ${seat} seat waits on a permission prompt the tick won't answer: ${state.prompt_what}. Answer it in session ${state.agent}.`;
    if (await steered(ports.steer, line)) writeSliceState(root, mission, id, { prompt_steered: "asked" });
    return;
  }
  const minutes = readFactory(root).manager.promptMinutes;
  const since = Date.parse(state.prompt_since);
  if (state.prompt_steered === "asked" && Number.isFinite(since) && now - since >= minutes * 60_000) {
    const line = `Slice ${id}'s ${seat} seat has waited ${Math.floor((now - since) / 60_000)} minutes on a permission prompt: ${state.prompt_what}. Answer it in session ${state.agent}.`;
    if (await steered(ports.steer, line)) writeSliceState(root, mission, id, { prompt_steered: "stalled" });
  }
}
