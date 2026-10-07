import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// Story belt: each phase runs in a fresh agent. A phase ends by writing a marker under
// `## Status` in .harness/state.md; the server reads that line when the agent's turn ends
// and starts the next phase.

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
  runs: skillRef,
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
  {
    id: "plan",
    label: "Plan",
    runs: { name: "ss-plan", source: MACHINE_SOURCE },
    extras: [],
    then: "you",
  },
  {
    id: "implement",
    label: "Implement",
    runs: { name: "ss-implement", source: MACHINE_SOURCE },
    extras: [{ name: "tdd", source: MACHINE_SOURCE }],
    then: "auto",
  },
  {
    id: "review",
    label: "Review",
    runs: { name: "ss-review", source: MACHINE_SOURCE },
    extras: [{ name: "ss-security-audit", source: MACHINE_SOURCE, required: true }],
    then: "pass",
  },
  {
    id: "done",
    label: "Done",
    runs: { name: "ss-submit-pr", source: MACHINE_SOURCE },
    extras: [],
    then: "merge",
  },
];

// Which handoffs each phase may use. Done always waits for the merge.
export const THEN_CHOICES: Record<PhaseId, Then[]> = {
  plan: ["you", "auto"],
  implement: ["auto", "you"],
  review: ["pass", "you"],
  done: ["merge"],
};

const beltValues = z.object({
  // Off: Start keeps the single-agent session. On: Start runs the Story belt.
  enabled: z.boolean().default(false),
  phases: z.array(phase).default(DEFAULT_PHASES),
  implementMode: z.enum(["step", "loop"]).default("step"),
  loopMax: z.number().int().min(1).max(20).default(6),
  reviewRounds: z.number().int().min(1).max(20).default(3),
  closeOnMerge: z.boolean().default(true),
  sources: z.array(source).default([]),
});

export const beltSettings = defineSettings({
  id: "belt",
  scope: "host",
  version: 2,
  schema: beltValues,
  migrate(values) {
    const row = values !== null && typeof values === "object" ? (values as Record<string, unknown>) : {};
    const parsed = beltValues.safeParse({ ...row, sources: [] });
    return parsed.success ? parsed.data : beltValues.parse({});
  },
});

export type BeltConfig = z.infer<typeof beltValues>;

const catalogSkill = z.object({
  name: z.string(),
  source: z.string(),
  kind: z.enum(["skill", "command"]),
});
export type CatalogSkill = z.infer<typeof catalogSkill>;

const sourceStatus = z.object({
  id: z.string(),
  ok: z.boolean(),
  error: z.string().nullable(),
  commit: z.string().nullable(),
  skillCount: z.number(),
});
export type SourceStatus = z.infer<typeof sourceStatus>;

export const getSkillCatalog = defineRpc({
  name: "orchestration.belt.catalog",
  input: z.object({}),
  output: z.object({
    skills: z.array(catalogSkill),
    sources: z.array(sourceStatus),
  }),
});

export const addSkillSource = defineRpc({
  name: "orchestration.belt.source.add",
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
  name: "orchestration.belt.source.check",
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
  name: "orchestration.belt.source.remove",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

export const startBeltStory = defineRpc({
  name: "orchestration.belt.start",
  input: z.object({
    workspaceId: z.string(),
    key: z.string(),
    title: z.string(),
    url: z.string().nullable(),
  }),
  output: z.object({ agentId: z.string(), warnings: z.array(z.string()) }),
});

export const BELT_AGENT_CONFIG = {
  provider: "cursor/grok-4.6",
  modeId: "agent",
  thinkingOptionId: "medium",
  featureValues: { auto_accept: true },
};

export const BELT_LABEL = "story";

export type Ticket = { key: string; title: string; url: string | null };

export function doneMarker(id: PhaseId) {
  return `${id}-done`;
}

export function nextPhase(phases: Phase[], id: PhaseId) {
  const index = phases.findIndex((p) => p.id === id);
  return index >= 0 ? (phases[index + 1] ?? null) : null;
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

export function phasePrompt(config: BeltConfig, phase: Phase, ticket: Ticket, round = 1) {
  const skills = phaseSkills(phase);
  const fixing = phase.id === "implement" && round > 1;
  const runs =
    phase.id === "implement" && config.implementMode === "loop" && !fixing ? "ss-loop" : skills.runs.name;
  const extras = skills.extras.map((e) => e.name);
  const lines = [
    `/${runs} ${ticket.key} — ${ticket.title}`,
    "",
    `Story belt, phase ${PHASE_IDS.indexOf(phase.id) + 1}/${PHASE_IDS.length}: ${phase.label}${round > 1 ? ` (round ${round})` : ""}. You are a fresh agent for this phase only.`,
    ticket.url ? `Jira: ${ticket.url}` : "",
    extras.length > 0 ? `Also use these skills: ${extras.join(", ")}.` : "",
    "Read the ticket and .harness/state.md with the attached MCP tools and files. Host MCP servers are already authenticated; do not open a browser or ask anyone to log in.",
    "",
    "Phase contract:",
    ...phaseContract(config, phase, fixing),
    ...(phase.then === "you" && phase.id !== "plan"
      ? ["- Before writing the done marker, summarise the result and wait for the user to say go."]
      : []),
    "Do not start the next phase yourself. The Orchestrator plugin starts it in a fresh agent when it sees the marker.",
  ];
  return lines.filter((line, i) => line !== "" || lines[i - 1] !== "").join("\n");
}

const STATUS =
  "the `## Status` section of `.harness/state.md` (replace its contents with the marker on its own line)";

function phaseContract(config: BeltConfig, phase: Phase, fixing: boolean) {
  const marker = `\`${doneMarker(phase.id)}\``;
  if (phase.id === "plan") {
    return phase.then === "you"
      ? [
          `- When the user has explicitly approved the plan, set ${STATUS} to ${marker}.`,
          "- Do not write the marker before approval. Asking questions and waiting is expected.",
        ]
      : [`- When the plan is complete, set ${STATUS} to ${marker}.`];
  }
  if (phase.id === "implement") {
    return [
      fixing
        ? "- Review failed. Fix only the findings listed under `## Status` / the review notes in .harness/state.md, with tests."
        : config.implementMode === "loop"
          ? `- Walk the Remaining cycles (at most ${config.loopMax}).`
          : "- Work the RED→GREEN plan cycle by cycle.",
      `- When every cycle is green${fixing ? " and the findings are fixed" : ""}, set ${STATUS} to ${marker}.`,
      "- If you are blocked, set it to `implement-blocked` and say why.",
    ];
  }
  if (phase.id === "review") {
    return [
      "- Review as a fresh critic, including the security audit. Do not fix findings yourself.",
      `- On PASS, set ${STATUS} to ${marker}.`,
      "- On FAIL, set it to `review-failed` and list the findings on the lines under it.",
    ];
  }
  return [
    "- Open the pull request and watch CI.",
    `- When the PR is open and CI is green, set ${STATUS} to ${marker}.`,
  ];
}

export function closePrompt(ticket: Ticket) {
  return [
    `/ss-close-story ${ticket.key}`,
    "",
    `The pull request for ${ticket.key} — ${ticket.title} merged. Close the story (subtasks first) with the attached Jira MCP tools.`,
    "Host MCP servers are already authenticated; do not open a browser or ask anyone to log in.",
  ].join("\n");
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
