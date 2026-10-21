import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { STEP_LABELS, type LoopStep } from "./initiative-loop";
import { DEFAULT_PHASES, phaseSkills, STEP_PHASES, type PipelineConfig } from "./pipeline";

// A repo's loop tree: the phases a story passes through and where each hands off on pass and on fail.
// It is stored per repo by the plugin (server/loop-trees.ts). Nothing in the loop reads it yet; this file
// is the shape, the default and the checks a saved tree must pass.

export const PHASE_KINDS = ["plan", "diagnose", "implement", "review", "custom", "open-pr", "fix-ci"] as const;
export type PhaseKind = (typeof PHASE_KINDS)[number];

const skillRef = z.object({ name: z.string(), source: z.string() });
const extra = skillRef.extend({ required: z.boolean().optional(), optional: z.boolean().optional() });

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const treePhase = z.object({
  id: z.string().regex(KEBAB, "id must be kebab-case"),
  label: z.string(),
  kind: z.enum(PHASE_KINDS),
  // A skill the phase's agent is told to use. null runs the built-in step on its own. Data only for now.
  runs: skillRef.nullable(),
  extras: z.array(extra),
  // An agent profile (id or name) the phase runs on, which sets its model.
  profile: z.string().optional(),
  role: z.string().optional(),
  // The phase to hand off to when this one passes or fails. null ends the run on that outcome.
  onPass: z.string().nullable(),
  onFail: z.string().nullable(),
  // An override for how many times a fail edge may be taken before the run stops. Absent means the repo
  // file's limit (reviewRounds for review, maxFixes for fix), which stays the only copy of it.
  retries: z.number().int().min(0).optional(),
}).strict();

// Where a run begins: a story at one phase, a bug at another. Strict, so a limit such as maxFixes
// (which lives in the repo's pipeline file) is refused instead of silently dropped.
export const loopTreeSchema = z
  .object({ start: z.object({ story: z.string(), bug: z.string() }).strict(), phases: z.array(treePhase) })
  .strict();

export type TreePhase = z.infer<typeof treePhase>;
export type LoopTree = z.infer<typeof loopTreeSchema>;

type DefaultStep = { step: LoopStep; kind: PhaseKind; onPass: LoopStep | null; onFail: LoopStep | null };

// The built-in loop as a graph, as reconcile in server/initiative-loop.ts moves it: plan and diagnose both hand
// to implement (diagnose is where a bug story starts, not a step after plan), review failures go back to
// implement, a failed PR goes to Fix CI and back.
const DEFAULT_STEPS: DefaultStep[] = [
  { step: "plan", kind: "plan", onPass: "implement", onFail: null },
  { step: "diagnose", kind: "diagnose", onPass: "implement", onFail: null },
  { step: "implement", kind: "implement", onPass: "review", onFail: null },
  { step: "review", kind: "review", onPass: "pr", onFail: "implement" },
  { step: "pr", kind: "open-pr", onPass: null, onFail: "fix" },
  { step: "fix", kind: "fix-ci", onPass: "pr", onFail: null },
];

// Each step takes its skills and profile from the drawer phase the loop already uses for it (STEP_PHASES),
// through phaseSkills so a team-required extra stays. Carried as data: the loop still runs extras only.
export function defaultTree(config: PipelineConfig): LoopTree {
  return {
    start: { story: "plan", bug: "diagnose" },
    phases: DEFAULT_STEPS.map(({ step, kind, onPass, onFail }) => {
      const id = STEP_PHASES[step];
      const source = config.phases.find((p) => p.id === id) ?? DEFAULT_PHASES.find((p) => p.id === id);
      const skills = source ? phaseSkills(source) : { runs: null, extras: [] };
      return {
        id: step,
        label: STEP_LABELS[step],
        kind,
        runs: skills.runs,
        extras: skills.extras,
        ...(source?.profile === undefined ? {} : { profile: source.profile }),
        onPass,
        onFail,
      };
    }),
  };
}

const quote = (id: string) => `"${id}"`;

// A tree's raw input checked into a typed tree, or the readable reasons it can't be one. Every message
// names the phase it is about. Shape errors come first; the graph is only checked once the shape is sound.
export function parseTree(input: unknown): { tree: LoopTree | null; errors: string[] } {
  const parsed = loopTreeSchema.safeParse(input);
  if (!parsed.success) {
    const raw = typeof input === "object" && input !== null && "phases" in input ? input.phases : undefined;
    const rawPhases: unknown[] = Array.isArray(raw) ? raw : [];
    const errors = parsed.error.issues.map((issue) => {
      const [head, index, ...rest] = issue.path;
      if (head === "phases" && typeof index === "number") {
        const row: unknown = rawPhases[index];
        const id = typeof row === "object" && row !== null && "id" in row ? row.id : undefined;
        const name = typeof id === "string" ? quote(id) : `#${index + 1}`;
        return `Phase ${name}: ${rest.join(".") || "invalid"}: ${issue.message}`;
      }
      return `Tree: ${issue.path.join(".") || "invalid"}: ${issue.message}`;
    });
    return { tree: null, errors };
  }
  const tree = parsed.data;
  const errors = graphErrors(tree);
  return errors.length === 0 ? { tree, errors } : { tree: null, errors };
}

export function validateTree(input: unknown): string[] {
  return parseTree(input).errors;
}

function graphErrors({ phases, start }: LoopTree): string[] {
  if (phases.length === 0) return ["Tree has no phases."];
  const ids = phases.map((p) => p.id);
  const errors: string[] = [];
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) errors.push(`Duplicate phase id ${quote(id)}.`);
  for (const p of phases) {
    for (const edge of ["onPass", "onFail"] as const) {
      const target = p[edge];
      if (target !== null && !ids.includes(target)) {
        errors.push(`Phase ${quote(p.id)} ${edge} points at ${quote(target)}, which is not a phase.`);
      }
    }
  }
  for (const [entry, id] of Object.entries(start)) {
    if (!ids.includes(id)) errors.push(`Start entry "${entry}" points at ${quote(id)}, which is not a phase.`);
  }
  if (errors.length > 0) return errors;

  const byId = new Map(phases.map((p) => [p.id, p]));
  // Every cycle must carry an onFail edge, so the onPass edges alone must never loop.
  const seen = new Set<string>();
  for (const start of phases) {
    const path: string[] = [];
    for (let at: string | null = start.id; at !== null; at = byId.get(at)?.onPass ?? null) {
      const back = path.indexOf(at);
      if (back >= 0) {
        const loop = path.slice(back);
        const key = [...loop].sort().join(",");
        if (!seen.has(key)) {
          seen.add(key);
          errors.push(
            `Phases ${[...loop, at].map(quote).join(" -> ")} loop through onPass edges only; a cycle needs an onFail edge.`,
          );
        }
        break;
      }
      path.push(at);
    }
  }
  if (errors.length > 0) return errors;

  // The pass path from each start entry must reach an open-pr phase.
  for (const id of new Set(Object.values(start))) {
    for (let at: TreePhase | undefined = byId.get(id); at; at = at.onPass === null ? undefined : byId.get(at.onPass)) {
      if (at.kind === "open-pr") break;
      if (at.onPass === null) {
        const message = `Phase ${quote(at.id)} stops the run on pass before any open-pr phase, so no PR is ever opened.`;
        if (!errors.includes(message)) errors.push(message);
        break;
      }
    }
  }
  return errors;
}

// The RPCs the per-repo store answers (server/loop-trees.ts). Save and import validate first and say why
// they refused; `repo` is the repo's absolute path.
const saved = z.object({ ok: z.boolean(), error: z.string().nullable() });

export const getLoopTree = defineRpc({
  name: "orchestration.loop-tree.get",
  input: z.object({ repo: z.string() }),
  // saved is false when the tree is the repo's computed default; error says why a saved one couldn't be read.
  output: z.object({ tree: loopTreeSchema, saved: z.boolean(), error: z.string().nullable() }),
});

export const saveLoopTree = defineRpc({
  name: "orchestration.loop-tree.save",
  // Unchecked here on purpose: an invalid tree comes back as { ok: false, error }, not as a failed call.
  input: z.object({ repo: z.string(), tree: z.unknown() }),
  output: saved,
});

export const resetLoopTree = defineRpc({
  name: "orchestration.loop-tree.reset",
  input: z.object({ repo: z.string() }),
  output: saved,
});

export const exportLoopTree = defineRpc({
  name: "orchestration.loop-tree.export",
  input: z.object({ repo: z.string() }),
  output: z.object({ text: z.string(), error: z.string().nullable() }),
});

export const importLoopTree = defineRpc({
  name: "orchestration.loop-tree.import",
  input: z.object({ repo: z.string(), text: z.string() }),
  output: saved,
});

export const copyLoopTree = defineRpc({
  name: "orchestration.loop-tree.copy",
  input: z.object({ from: z.string(), to: z.string() }),
  output: saved,
});
