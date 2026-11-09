import { existsSync } from "node:fs";
import { join } from "node:path";
import type { VoiceRequest } from "../shared/voice-session";
import { factoryDir, readFactory } from "./factory-layout";
import { writeFrontmatter } from "./harness-layout";

// Env marker the factory puts on the manager session it creates; the agent.create hook looks for it.
export const FACTORY_MANAGER_ENV = "ORCHESTRATOR_FACTORY_MANAGER";

// The manager's system prompt: its role, then the three limits the factory plan sets for it.
export const MANAGER_PROMPT = [
  "Factory manager:",
  "You are the factory manager. You talk to the human, write the factory files under `.harness/factory/`, and report status.",
  "Limits:",
  "- You do not edit product code.",
  "- You do not tell a worker to rewrite `culture.md` or seat notes.",
  "- You do not treat another agent's approval as permission to merge.",
].join("\n");

// A request marked with FACTORY_MANAGER_ENV gets the manager prompt appended to its system prompt. Any other request
// comes back as the same object.
export function applyFactoryManager<T extends VoiceRequest>(request: T): T {
  if (request.env?.[FACTORY_MANAGER_ENV] !== "1") {
    return request;
  }
  const { systemPrompt } = request.config;
  return { ...request, config: { ...request.config, systemPrompt: systemPrompt ? `${systemPrompt}\n\n${MANAGER_PROMPT}` : MANAGER_PROMPT } };
}

// The models the manager runs on, in order: the create falls through to the next when one fails (provider missing or
// signed out). The client wants config.provider as "provider/model", like `materializeProfile` builds it. The Claude
// one runs in auto mode, so the router's default target never stops to ask permission on a voice steer.
export const MANAGER_MODELS = [
  { provider: "claude/claude-opus-5-5", modeId: "auto" },
  { provider: "cursor/grok-4.7" },
];

// The slice of Paseo the manager needs; tests pass a fake.
export type ManagerPaseo = {
  agents: {
    ref(id: string): {
      refresh(): Promise<{ agent: { status?: string; archivedAt?: string | null } } | null>;
      send(text: string, options: { activeTurnBehavior: "steer" }): Promise<unknown>;
    };
    create(request: {
      cwd: string;
      config: { provider: string };
      env: Record<string, string>;
      title: string;
      labels: Record<string, string>;
      prompt?: string;
    }): Promise<{ id: string }>;
  };
};

const creating = new Map<string, Promise<string | null>>();

// The factory manager's session id for the factory at root: the one in manager.md while it is live, else a fresh one
// (written to manager.md). Null when root has no factory. A Paseo that doesn't answer throws rather than risk a second
// manager; two callers at once share one create.
export function ensureManager(root: string, ports: ManagerPaseo): Promise<string | null> {
  const pending = creating.get(root);
  if (pending) return pending;
  const run = ensure(root, ports).finally(() => creating.delete(root));
  creating.set(root, run);
  return run;
}

async function ensure(root: string, ports: ManagerPaseo): Promise<string | null> {
  if (!existsSync(factoryDir(root))) return null;
  const known = readFactory(root).manager.agent;
  if (known) {
    const session = (await ports.agents.ref(known).refresh())?.agent;
    // Same test as the initiative loop's.
    const dead = !session || Boolean(session.archivedAt) || session.status === "closed" || session.status === "error";
    if (!dead) return known;
  }
  let failure: unknown;
  for (const config of MANAGER_MODELS) {
    try {
      const { id } = await ports.agents.create({
        cwd: root,
        config,
        env: { [FACTORY_MANAGER_ENV]: "1" },
        title: "Factory manager",
        labels: { kind: "factory-manager" },
      });
      writeFrontmatter(join(factoryDir(root), "manager.md"), { agent: id });
      return id;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

// The status steer: one line sent as a steer to the factory manager (replaced first if it is dead), and to no other
// session. False, with nothing sent, when root has no factory.
export async function steerManager(root: string, line: string, ports: ManagerPaseo): Promise<boolean> {
  const id = await ensureManager(root, ports);
  if (!id) return false;
  await ports.agents.ref(id).send(line, { activeTurnBehavior: "steer" });
  return true;
}
