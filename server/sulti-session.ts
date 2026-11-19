import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { VoiceRequest } from "../shared/voice-session";
import { liveOrCreate, type ManagerPaseo, SYSTEM_TAG } from "./factory-manager";

// Env marker the plugin puts on the Sulti session it creates; the agent.create hook looks for it.
export const SULTI_SESSION_ENV = "ORCHESTRATOR_SULTI_SESSION";

// The Sulti session's system prompt: its role, then the limits the factory plan sets for it.
export const SULTI_PROMPT = [
  "Sulti:",
  "You are Sulti, the global manager. You talk to the human, use the Paseo tools to list and read sessions across all repos, and steer a repo's factory manager when the human asks.",
  `Lines starting with ${SYSTEM_TAG} come from a repo's factory tick, not the human, and name the repo. Tell the human what needs them, in a sentence or two.`,
  "A change to a factory file (approving a plan, clearing `ready`) is that repo's manager's to write: steer the manager (its id is `agent` in the repo's `.harness/factory/manager.md`, or `manager` in the mission's `mission.md`) with the human's decision, never on your own.",
  "Limits:",
  "- Never send a prompt to your own session, whose id is `$PASEO_AGENT_ID`.",
  "- You do not edit product code.",
  "- You do not treat another agent's approval as permission to merge.",
].join("\n");

// A request marked with SULTI_SESSION_ENV gets the Sulti prompt appended to its system prompt. Any other request comes
// back as the same object.
export function applySultiSession<T extends VoiceRequest>(request: T): T {
  if (request.env?.[SULTI_SESSION_ENV] !== "1") {
    return request;
  }
  const { systemPrompt } = request.config;
  return { ...request, config: { ...request.config, systemPrompt: systemPrompt ? `${systemPrompt}\n\n${SULTI_PROMPT}` : SULTI_PROMPT } };
}

// The id in <home>/sulti.json, or undefined when there is none or the file can't be read.
export function readSultiId(home = join(homedir(), ".orchestrator")): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(home, "sulti.json"), "utf8")) as { agent?: string }).agent;
  } catch {
    return undefined;
  }
}

const creating = new Map<string, Promise<string>>();

// The Sulti session's id: the one in <home>/sulti.json while it is live, else a fresh one in <home>/sulti (made on first
// use, written to sulti.json). The id stays out of the session's own folder and out of any repo's manager.md. A Paseo that
// doesn't answer throws rather than risk a second Sulti; two callers at once share one create.
export function ensureSulti(ports: ManagerPaseo, home = join(homedir(), ".orchestrator")): Promise<string> {
  const pending = creating.get(home);
  if (pending) return pending;
  const run = ensure(ports, home).finally(() => creating.delete(home));
  creating.set(home, run);
  return run;
}

async function ensure(ports: ManagerPaseo, home: string): Promise<string> {
  const idFile = join(home, "sulti.json");
  const known = existsSync(idFile) ? (JSON.parse(readFileSync(idFile, "utf8")) as { agent?: string }).agent : undefined;
  const cwd = join(home, "sulti");
  mkdirSync(cwd, { recursive: true });
  const { id, created } = await liveOrCreate(known, { cwd, env: { [SULTI_SESSION_ENV]: "1" }, title: "Sulti", labels: { kind: "sulti" } }, ports);
  if (created) writeFileSync(idFile, JSON.stringify({ agent: id }));
  return id;
}

// A factory status line to the Sulti session, tagged with SYSTEM_TAG and the repo (and mission) it came from. Sulti is never
// created for it: false, with nothing sent, when sulti.json names no session or that session is dead, so the caller can
// fall back to the repo's manager.
export async function steerSulti(root: string, line: string, ports: ManagerPaseo, mission?: string, home = join(homedir(), ".orchestrator")): Promise<boolean> {
  const id = readSultiId(home);
  if (!id) return false;
  const session = (await ports.agents.ref(id).refresh())?.agent;
  // Same test as `liveOrCreate`'s.
  if (!session || session.archivedAt || session.status === "closed" || session.status === "error") return false;
  const from = mission ? `${basename(root)} factory, mission ${mission}` : `${basename(root)} factory`;
  await ports.agents.ref(id).send(`${SYSTEM_TAG} ${from}: ${line}`, { activeTurnBehavior: "steer" });
  return true;
}
