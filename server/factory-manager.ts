import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { materializeProfile, pickProfile, productStepConfig, profilesFromConfigGet, type AgentCreateConfig } from "../shared/agent-runner";
import type { LoopStep } from "../shared/story-method";
import type { VoiceRequest } from "../shared/voice-session";
import { factoryDir, readFactory } from "./factory-layout";
import { writeFrontmatter } from "./harness-layout";

export const HEARTHPLAY_E4_MISSION = "hearthplay-e4";

// Hearthplay factory slices are product repos: Plan on Cursor Opus, Review and Diagnose on Grok, build steps on Composer.
export async function hearthplayStepConfig(
  step: LoopStep,
  mission: string | undefined,
  profilesPort: { config: { get(): Promise<unknown> } },
  fallback: () => Promise<AgentCreateConfig>,
): Promise<AgentCreateConfig> {
  if (mission !== HEARTHPLAY_E4_MISSION) return fallback();
  try {
    const profiles = profilesFromConfigGet(await profilesPort.config.get());
    const forced = productStepConfig(step, profiles);
    if (forced) return forced;
    const composer = pickProfile(profiles, "Business - Coder") ?? profiles.find((item) => item.model === "composer-2.5");
    if (composer) return materializeProfile(composer);
  } catch {
    // Fall through to explicit Cursor providers.
  }
  if (step === "plan") return { provider: "cursor/claude-opus-5-5" };
  if (step === "review" || step === "diagnose") return { provider: "cursor/grok-4.7" };
  return { provider: "cursor/composer-2.5" };
}

// Env marker the factory puts on the manager session it creates; the agent.create hook looks for it.
export const FACTORY_MANAGER_ENV = "ORCHESTRATOR_FACTORY_MANAGER";

// The tag on every line the factory's own code steers to the manager, so it can tell those from the human's words.
export const SYSTEM_TAG = "[system]";

// The manager's system prompt: its role, then the three limits the factory plan sets for it.
export const MANAGER_PROMPT = [
  "Factory manager:",
  "You are the factory manager. You talk to the human, write the factory files under `.harness/factory/`, and report status.",
  `Lines starting with ${SYSTEM_TAG} come from the factory's own code, not the human.`,
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

// The manager session's own list: Sulti creates it when a router has no target, and it is the one the human talks to, so
// it runs on Sonnet, else Composer, not on the deep model the seats start on. Sonnet runs in auto mode like the list above.
export const MANAGER_SESSION_MODELS = [
  { provider: "claude/claude-sonnet-5-5", modeId: "auto" },
  { provider: "cursor/composer-2.5" },
];

// A repo's factory manager runs on Cursor Composer, except this repo's own, which keeps MANAGER_SESSION_MODELS.
export const REPO_MANAGER_MODELS = [{ provider: "cursor/composer-2.5" }];

// Seat creates on other repos' slices: Composer for every role (or a named Cursor profile), Grok deep as fallback.
export const REPO_SEAT_FALLBACKS = [{ provider: "cursor/grok-4.7" }] as const;
export const REPO_SEAT_MODELS = [{ provider: "cursor/composer-2.5" }, ...REPO_SEAT_FALLBACKS] as const;

// The repo a slice's seats run in: its worktree checkout (git toplevel or package.json there), else the factory home.
export function sliceRepoRoot(worktree: string, factoryHome: string): string {
  if (worktree && existsSync(worktree)) {
    try {
      const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (top) return top;
    } catch {
      // not a git checkout
    }
    if (existsSync(join(worktree, "package.json"))) return worktree;
    try {
      const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        cwd: worktree,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (common) return join(isAbsolute(common) ? common : join(worktree, common), "..");
    } catch {
      // no git metadata
    }
  }
  return factoryHome;
}

// True when root is a checkout of this repo (any worktree), by its package name.
export function isOrchestratorRepo(root: string): boolean {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name === "@denmercs/orchestrator";
  } catch {
    return false;
  }
}

// True for the gihimo product repo (by package name, or path basename when package.json is missing).
export function isGihimoRepo(root: string): boolean {
  try {
    if (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name === "gihimo") return true;
  } catch {
    // fall through to basename
  }
  return basename(root) === "gihimo";
}

// Product repos default Plan to Cursor Opus and Review to Grok; Orchestrator and gihimo keep their own rules.
export function usesProductPlanReviewDefaults(root: string): boolean {
  return !isOrchestratorRepo(root) && !isGihimoRepo(root);
}

// Loop and Story steps: the initiative repo root when it has a package.json, else the worktree checkout.
export function loopRepoRoot(worktree: string | null, loopRepo: string | null | undefined): string {
  if (loopRepo && existsSync(join(loopRepo, "package.json"))) return loopRepo;
  if (worktree) return sliceRepoRoot(worktree, loopRepo ?? worktree);
  return loopRepo ?? "";
}

// The models a factory manager is created on: manager.md's `model` (`provider/model`), then the entries of `defaults` from
// that provider only, so a run stays on one provider; `defaults` as they are when it names none. A Claude model runs in
// auto mode, so the manager never stops to ask permission on a steer.
export function managerModels(model: string, defaults: readonly { provider: string; modeId?: string }[]): { provider: string; modeId?: string }[] {
  if (!model) return [...defaults];
  const provider = model.split("/")[0];
  return [
    provider === "claude" ? { provider: model, modeId: "auto" } : { provider: model },
    ...defaults.filter((config) => config.provider !== model && config.provider.split("/")[0] === provider),
  ];
}

// The slice of Paseo the manager needs; tests pass a fake.
export type ManagerPaseo = {
  agents: {
    ref(id: string): {
      refresh(): Promise<{ agent: { status?: string; archivedAt?: string | null } } | null>;
      send(text: string, options: { activeTurnBehavior: "steer" }): Promise<unknown>;
    };
    create(request: {
      cwd: string;
      config: { provider: string; modeId?: string };
      env: Record<string, string>;
      title: string;
      labels: Record<string, string>;
      prompt?: string;
    }): Promise<{ id: string }>;
  };
};

const creating = new Map<string, Promise<string | null>>();

const ensureKey = (root: string, mission?: string) => (mission ? `${root}:${mission}` : root);

const missionManagerFile = (root: string, mission: string) => join(factoryDir(root), "missions", mission, "mission.md");

// The Paseo agent id in a mission's `manager` frontmatter when set; empty means fall back to manager.md.
export function missionManagerAgent(root: string, mission: string | undefined): string | undefined {
  if (!mission) return undefined;
  const agent = readFactory(root).missions.find((item) => item.id === mission)?.manager.trim();
  return agent || undefined;
}

// The factory manager's session id for the factory at root: the one in manager.md while it is live, else a fresh one
// (written to manager.md). With `mission`, a non-empty `manager:` on that mission's mission.md is used instead and
// written back there on create. Null when root has no factory. A Paseo that doesn't answer throws rather than risk a
// second manager; two callers at once share one create (per mission when routed).
export function ensureManager(root: string, ports: ManagerPaseo, mission?: string): Promise<string | null> {
  const key = ensureKey(root, missionManagerAgent(root, mission) ? mission : undefined);
  const pending = creating.get(key);
  if (pending) return pending;
  const run = ensure(root, ports, mission).finally(() => creating.delete(key));
  creating.set(key, run);
  return run;
}

async function ensure(root: string, ports: ManagerPaseo, mission?: string): Promise<string | null> {
  if (!existsSync(factoryDir(root))) return null;
  const factory = readFactory(root);
  const override = missionManagerAgent(root, mission);
  const { id, created } = await liveOrCreate(
    override ?? factory.manager.agent,
    {
      cwd: root,
      env: { [FACTORY_MANAGER_ENV]: "1" },
      title: override && mission ? `Factory manager (${mission})` : "Factory manager",
      labels: override && mission ? { kind: "factory-manager", "factory-mission": mission } : { kind: "factory-manager" },
    },
    ports,
    managerModels(factory.manager.model, isOrchestratorRepo(root) ? MANAGER_SESSION_MODELS : REPO_MANAGER_MODELS),
  );
  if (created) {
    if (override && mission) writeFrontmatter(missionManagerFile(root, mission), { manager: id });
    else writeFrontmatter(join(factoryDir(root), "manager.md"), { agent: id });
  }
  return id;
}

// The session id to use for `known`: itself while Paseo reports it live, else a fresh session made from `spec` on the
// first of `models` (default MANAGER_SESSION_MODELS) that creates (the create falls through to the next on failure; the last failure is
// thrown). Shared by the factory manager (`managerModels`) and Sulti. The caller records the id when `created`; a Paseo that doesn't answer throws.
export async function liveOrCreate(
  known: string | undefined,
  spec: { cwd: string; env: Record<string, string>; title: string; labels: Record<string, string> },
  ports: ManagerPaseo,
  models: readonly { provider: string; modeId?: string }[] = MANAGER_SESSION_MODELS,
): Promise<{ id: string; created: boolean }> {
  if (known) {
    const session = (await ports.agents.ref(known).refresh())?.agent;
    // Same test as the initiative loop's.
    const dead = !session || Boolean(session.archivedAt) || session.status === "closed" || session.status === "error";
    if (!dead) return { id: known, created: false };
  }
  let failure: unknown;
  for (const config of models) {
    try {
      const { id } = await ports.agents.create({ ...spec, config });
      return { id, created: true };
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

// The status steer: one line, prefixed with SYSTEM_TAG, sent as a steer to the factory manager (replaced first if it is dead), and to no other
// session. With `mission`, routes to that mission's `manager:` agent when set, else manager.md. False, with nothing sent,
// when root has no factory.
export async function steerManager(root: string, line: string, ports: ManagerPaseo, mission?: string): Promise<boolean> {
  const id = await ensureManager(root, ports, mission);
  if (!id) return false;
  await ports.agents.ref(id).send(`${SYSTEM_TAG} ${line}`, { activeTurnBehavior: "steer" });
  return true;
}
