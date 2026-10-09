import { defineRpc, defineSettings, PluginAttachmentSearchPayloadSchema } from "@getpaseo/plugin";
import { z } from "zod";
import type { LoopStep } from "./initiative-loop";
import { stepPrompt, type Cycle, type StoryContext } from "./story-method";

// Story pipeline: a Jira story run through the same steps as the initiative loop (shared/story-method.ts).
// Plan, each Implement cycle and Review run in fresh agents. A step ends by writing a marker under
// `## Status` in .harness/state.md; the server reads that line when the agent's turn ends and starts
// the next one. Done has no agent: the plugin opens the PR and, after the merge, closes the Jira story.

export const PHASE_IDS = ["plan", "implement", "review", "done"] as const;
export type PhaseId = (typeof PHASE_IDS)[number];
export const THEN_VALUES = ["you", "auto", "pass", "merge"] as const;
export type Then = (typeof THEN_VALUES)[number];

// Skills already on this machine (~/.claude, ~/.agents). Nothing is copied for these.
export const MACHINE_SOURCE = "installed";

const skillRef = z.object({ name: z.string(), source: z.string() });
const extra = skillRef.extend({
  required: z.boolean().optional(),
  optional: z.boolean().optional(),
});
const phase = z.object({
  id: z.enum(PHASE_IDS),
  label: z.string(),
  // A skill the phase's agent is told to use. null runs the built-in step on its own.
  runs: skillRef.nullable(),
  extras: z.array(extra),
  then: z.enum(THEN_VALUES),
});
const source = z.object({
  id: z.string(),
  label: z.string(),
  // owner/repo, a git URL, or an absolute folder path.
  location: z.string(),
  kind: z.enum(["team", "personal", "imported"]),
  enabled: z.boolean(),
  // Git sources are pinned to a commit and only move when someone presses Update.
  // Folder sources have no pin and are read live.
  pin: z.string().nullable(),
});

export type SkillRef = z.infer<typeof skillRef>;
export type Extra = z.infer<typeof extra>;
export type Phase = z.infer<typeof phase>;
export type SkillSource = z.infer<typeof source>;

export const DEFAULT_PHASES: Phase[] = [
  { id: "plan", label: "Plan", runs: null, extras: [], then: "you" },
  { id: "implement", label: "Implement", runs: null, extras: [], then: "auto" },
  { id: "review", label: "Review", runs: null, extras: [], then: "pass" },
  { id: "done", label: "Done", runs: null, extras: [], then: "merge" },
];

// Which handoffs each phase may use. Done always waits for the merge.
export const THEN_CHOICES: Record<PhaseId, Then[]> = {
  plan: ["you", "auto"],
  implement: ["auto", "you"],
  review: ["pass", "you"],
  done: ["merge"],
};

const pipelineValues = z.object({
  // Off: Start keeps the single-agent session. On: Start runs the Story pipeline.
  enabled: z.boolean().default(false),
  phases: z.array(phase).default(DEFAULT_PHASES),
  reviewRounds: z.number().int().min(1).max(20).default(3),
  // Fix CI attempts per story PR before the pipeline stops and leaves it to you.
  maxFixes: z.number().int().min(1).max(20).default(3),
  closeOnMerge: z.boolean().default(true),
  sources: z.array(source).default([]),
});

export const pipelineSettings = defineSettings({
  id: "pipeline",
  scope: "host",
  version: 3,
  schema: pipelineValues,
  migrate(values) {
    const row = values !== null && typeof values === "object" ? (values as Record<string, unknown>) : {};
    const phases = Array.isArray(row.phases) ? row.phases.map(withoutSkillsync) : undefined;
    const parsed = pipelineValues.safeParse({ ...row, phases });
    return parsed.success ? parsed.data : pipelineValues.parse({});
  },
});

// skillsync is retired: its machine skills (ss-*, tdd) were the old phase defaults. Saved phases drop
// them so the built-in steps run; skills from connected sources are kept.
function isSkillsync(ref: unknown) {
  const row = ref !== null && typeof ref === "object" ? (ref as Record<string, unknown>) : {};
  const name = typeof row.name === "string" ? row.name : "";
  return row.source === MACHINE_SOURCE && (name.startsWith("ss-") || name === "tdd");
}

export function withoutSkillsync(saved: unknown) {
  if (saved === null || typeof saved !== "object") return saved;
  const row = saved as Record<string, unknown>;
  return {
    ...row,
    runs: row.runs === undefined || isSkillsync(row.runs) ? null : row.runs,
    extras: Array.isArray(row.extras) ? row.extras.filter((extra) => !isSkillsync(extra)) : [],
  };
}

export type PipelineConfig = z.infer<typeof pipelineValues>;

const catalogSkill = z.object({
  name: z.string(),
  // The skill's folder (or command file) name; `name` comes from SKILL.md frontmatter when set.
  folder: z.string(),
  description: z.string(),
  source: z.string(),
  kind: z.enum(["skill", "command"]),
});
export type CatalogSkill = z.infer<typeof catalogSkill>;

// A ref points at a catalog skill on the same source by its name or its folder, so refs saved
// with folder names keep working when the frontmatter name differs.
export function matchesRef(skill: CatalogSkill, ref: SkillRef) {
  return skill.source === ref.source && (skill.name === ref.name || skill.folder === ref.name);
}

// The one catalog skill a ref points at: an exact name match wins over a folder match.
export function findRef(catalog: CatalogSkill[], ref: SkillRef) {
  return (
    catalog.find((s) => s.source === ref.source && s.name === ref.name) ??
    catalog.find((s) => matchesRef(s, ref))
  );
}

const sourceStatus = z.object({
  id: z.string(),
  ok: z.boolean(),
  error: z.string().nullable(),
  commit: z.string().nullable(),
  skillCount: z.number(),
});
export type SourceStatus = z.infer<typeof sourceStatus>;

export const getSkillCatalog = defineRpc({
  name: "orchestration.pipeline.catalog",
  input: z.object({}),
  output: z.object({
    skills: z.array(catalogSkill),
    sources: z.array(sourceStatus),
  }),
});

export const addSkillSource = defineRpc({
  name: "orchestration.pipeline.source.add",
  input: z.object({ location: z.string() }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    id: z.string(),
    label: z.string(),
    location: z.string(),
    pin: z.string().nullable(),
    skillCount: z.number(),
  }),
});

export const checkSkillSource = defineRpc({
  name: "orchestration.pipeline.source.check",
  input: z.object({ id: z.string() }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    head: z.string().nullable(),
    commits: z.array(z.object({ sha: z.string(), subject: z.string() })),
    changedSkills: z.array(z.string()),
  }),
});

export const removeSkillSource = defineRpc({
  name: "orchestration.pipeline.source.remove",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

// skills.sh search. `connected` is true when the hit's repo is already a skill source.
// Failures come back as `error` with no results.
const registryHit = z.object({
  source: z.string(),
  skillId: z.string(),
  name: z.string(),
  installs: z.number(),
  connected: z.boolean(),
});
export type RegistryHit = z.infer<typeof registryHit>;

export const searchSkillRegistry = defineRpc({
  name: "orchestration.pipeline.registry.search",
  input: z.object({ query: z.string() }),
  output: z.object({ results: z.array(registryHit), error: z.string().nullable() }),
});
export type RegistrySearch = z.infer<typeof searchSkillRegistry.output>;

// The composer's Skills attachment source: searches the catalog and returns attachable skills.
export const attachSkill = defineRpc({
  name: "orchestration.skills.attach",
  input: z.object({ query: z.string() }),
  output: PluginAttachmentSearchPayloadSchema,
});

export const startPipelineStory = defineRpc({
  name: "orchestration.pipeline.start",
  input: z.object({
    workspaceId: z.string(),
    key: z.string(),
    title: z.string(),
    url: z.string().nullable(),
  }),
  output: z.object({ agentId: z.string(), warnings: z.array(z.string()) }),
});

export const PIPELINE_LABEL = "story";

export type Ticket = { key: string; title: string; url: string | null };

export function doneMarker(id: PhaseId) {
  return `${id}-done`;
}

export function phaseTitle(key: string, title: string, phaseLabel: string) {
  const label = `${key} · ${phaseLabel} — ${title}`.trim();
  return label.length > 60 ? `${label.slice(0, 57)}...` : label;
}

// Team-required skills are always loaded, even if a saved config dropped them.
export function phaseSkills(phase: Phase) {
  const defaults = DEFAULT_PHASES.find((p) => p.id === phase.id);
  const required = (defaults?.extras ?? []).filter(
    (r) => r.required && !phase.extras.some((e) => e.name === r.name),
  );
  return { runs: phase.runs, extras: [...phase.extras, ...required] };
}

// The drawer phase whose extras each loop step loads. Fix reworks code, so it uses Implement's.
export const STEP_PHASES: Record<LoopStep, PhaseId> = {
  plan: "plan",
  implement: "implement",
  fix: "implement",
  review: "review",
  pr: "done",
};

// A loop step's extras from the saved phases, or the default phase when they lack it. Never `runs`.
export function stepSkills(step: LoopStep, phases: Phase[]): Extra[] {
  const id = STEP_PHASES[step];
  const phase = phases.find((p) => p.id === id) ?? DEFAULT_PHASES.find((p) => p.id === id);
  return phase ? phaseSkills(phase).extras : [];
}

export function pipelineStory(ticket: Ticket, branch = "", base = "origin/main"): StoryContext {
  return {
    id: ticket.key,
    title: ticket.title,
    body: "",
    ticketUrl: ticket.url,
    storyFile: null,
    storiesDir: null,
    phaseLabel: null,
    phaseTitle: null,
    architectureFile: null,
    initiativeTitle: null,
    initiativeFile: null,
    branch,
    base,
  };
}

export type PhasePromptOptions = {
  round?: number;
  cycle?: Cycle;
  plan?: string;
  branch?: string;
  base?: string;
  // Fix CI: the failed checks and their log summaries.
  failing?: string;
};

export const DONE_DESCRIPTION =
  "No agent. The plugin commits anything left, pushes the branch and opens the PR from .harness/pr-body.md, then waits for you to merge.";

function skillNames(phase: Phase) {
  const skills = phaseSkills(phase);
  return [skills.runs?.name, ...skills.extras.map((e) => e.name)]
    .filter((name): name is string => Boolean(name))
    .map((name) => ({ name }));
}

export function phasePrompt(phase: Phase, ticket: Ticket, options: PhasePromptOptions = {}) {
  if (phase.id === "done") return DONE_DESCRIPTION;
  const story = pipelineStory(ticket, options.branch, options.base);
  const lines = [
    stepPrompt(phase.id, story, {
      round: options.round ?? 1,
      cycle: options.cycle,
      plan: options.plan,
      skills: skillNames(phase),
    }),
  ];
  if (phase.id === "plan" && phase.then === "auto") {
    lines.push("", "This pipeline runs Plan without approval: when the plan is complete, set `## Status` to `plan-done` without waiting.");
  }
  if (phase.id !== "plan" && phase.then === "you") {
    lines.push("", "Before writing your marker, summarise the result and wait for the user to say go.");
  }
  return lines.join("\n");
}

// Fix CI is not a drawer phase: the plugin starts it when a story PR's checks fail. Like the initiative
// loop's Fix CI (STEP_PHASES), it loads the Implement phase's skills.
export const FIX_CI = { id: "fix", label: "Fix CI" } as const;

export function fixPrompt(implement: Phase, ticket: Ticket, options: PhasePromptOptions = {}) {
  return stepPrompt("fix", pipelineStory(ticket, options.branch, options.base), {
    round: options.round ?? 1,
    failing: options.failing,
    skills: skillNames(implement),
  });
}

export function readStatus(stateMarkdown: string) {
  const match = stateMarkdown.match(/^##\s+Status\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m);
  const body = match?.[1] ?? "";
  const first = body
    .split("\n")
    .map((line) => line.trim().replace(/^`|`$/g, ""))
    .find((line) => line.length > 0);
  return first?.toLowerCase() ?? null;
}
