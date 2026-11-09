// The story drawer's session map: the loop's main session, the subagents it spawned, and the reviewer
// that wakes on call, each with its provider and model. Kept free of React and the Paseo client so it
// can be tested on its own.

import { STEP_LABELS, type LoopStep } from "../shared/initiative-loop";

// Paseo stamps spawned sessions with this label; the protocol package does not export it.
const PARENT_LABEL = "paseo.parent-agent-id";
const LIVE = new Set(["running", "initializing"]);

// The parts of a Paseo agent snapshot the map reads.
export type MapAgent = {
  id: string;
  title: string | null;
  status: string;
  provider: string;
  model?: string | null;
  labels?: Record<string, string>;
  parentAgentId?: string | null;
};

export type NodeState = "running" | "done" | "error";

export type MapNode = {
  id: string;
  title: string;
  provider: string;
  // "Sonnet 5.5", "Composer 2.5"; the provider alone when the session reports no model.
  model: string;
  state: NodeState;
};

export type Reviewer = { state: "asleep" | "awake"; wakes: number; model: string | null };

export type SessionMap = {
  main: MapNode | null;
  workers: MapNode[];
  reviewer: Reviewer;
  // Providers in play, in the order they first appear. More than one breaks the one-provider-per-run rule.
  providers: string[];
  mixed: boolean;
};

function parentOf(agent: MapAgent) {
  return agent.labels?.[PARENT_LABEL]?.trim() || agent.parentAgentId || null;
}

// "claude-sonnet-5-5" → "Sonnet 5.5", "composer-2.5" → "Composer 2.5", "gpt-5" → "Gpt 5".
export function modelLabel(provider: string, model?: string | null): string {
  const raw = (model ?? "").trim();
  if (!raw) return provider;
  const parts = raw
    .replace(/^claude-/, "")
    .split("-")
    .filter(Boolean);
  const words: string[] = [];
  const digits: string[] = [];
  for (const part of parts) (/^\d+(\.\d+)?$/.test(part) ? digits : words).push(part);
  const name = words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
  return [name, digits.join(".")].filter(Boolean).join(" ") || raw;
}

function stateOf(status: string): NodeState {
  if (LIVE.has(status)) return "running";
  if (status === "error" || status === "failed") return "error";
  // An idle session finished its turn; the loop decides whether more is coming.
  return "done";
}

function titleOf(agent: MapAgent) {
  const step = agent.labels?.["loop-step"];
  const label = step && Object.hasOwn(STEP_LABELS, step) ? STEP_LABELS[step as LoopStep] : "";
  return label || agent.title || agent.id;
}

function node(agent: MapAgent, state = stateOf(agent.status)): MapNode {
  return { id: agent.id, title: titleOf(agent), provider: agent.provider, model: modelLabel(agent.provider, agent.model), state };
}

// loop: the story's loop sessions, oldest first. all: every live session, to find the subagents the
// main session spawned.
export function sessionMap(loop: MapAgent[], all: MapAgent[]): SessionMap {
  const reviews = loop.filter((agent) => agent.labels?.["loop-step"] === "review");
  const builders = loop.filter((agent) => agent.labels?.["loop-step"] !== "review");
  const mainAgent = builders.at(-1) ?? null;
  const workers = mainAgent ? all.filter((agent) => parentOf(agent) === mainAgent.id).map((agent) => node(agent)) : [];

  const lastReview = reviews.at(-1) ?? null;
  const providers = [...new Set([...loop, ...all.filter((agent) => workers.some((worker) => worker.id === agent.id))].map((agent) => agent.provider))];
  return {
    main: mainAgent ? node(mainAgent) : null,
    workers,
    reviewer: {
      state: lastReview && LIVE.has(lastReview.status) ? "awake" : "asleep",
      wakes: reviews.length,
      model: lastReview ? modelLabel(lastReview.provider, lastReview.model) : null,
    },
    providers,
    mixed: providers.length > 1,
  };
}

const PROVIDER_NAMES: Record<string, string> = { claude: "Claude", cursor: "Cursor" };

export function providerLabel(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider[0]?.toUpperCase() + provider.slice(1);
}

// The one line under the map: which provider(s) the run is on, and a warning when they mix.
export function providerNote(map: SessionMap): string {
  if (!map.providers.length) return "";
  const names = map.providers.map(providerLabel).join(" + ");
  return map.mixed ? `Mixed providers: ${names}. A run should stay on one.` : `${names} only`;
}
