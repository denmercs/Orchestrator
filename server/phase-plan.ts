import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { epicDirFor, initiativeTitle, initiativesDir } from "./harness-layout";
import { planNamesJira, refreshPlanFromJira, syncPlanFromStories } from "./plan-status";
import { planUrl } from "./plan-server";
import { PLAN_MD, renderPhasePlan } from "./plan-render";

// A phase's architecture plan as files: render its HTML view, serve it, refresh it from Jira.

function phaseOf(input: { repo: string; epic: string }) {
  const root = resolve(input.repo);
  const epicDir = epicDirFor(root, input.epic);
  if (!epicDir) throw new Error(`${input.epic} is not a phase under .harness/initiatives.`);
  const slug = relative(initiativesDir(root), epicDir).split(sep)[0];
  return {
    root,
    epicDir,
    initiative: initiativeTitle(join(initiativesDir(root), slug)),
    source: relative(root, join(epicDir, PLAN_MD)).split(sep).join("/"),
  };
}

const errorOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

// Syncs story statuses into the plan, then re-renders when the Markdown changed; cheap enough to
// call on every board poll.
export function renderPlanFor(input: { repo: string; epic: string }) {
  try {
    const phase = phaseOf(input);
    syncPlanFromStories(phase.epicDir);
    const rendered = renderPhasePlan(phase.epicDir, phase);
    if (!rendered) return null;
    return { warnings: rendered.warnings, jira: planNamesJira(readFileSync(join(phase.epicDir, PLAN_MD), "utf8")) };
  } catch {
    return null;
  }
}

// A loopback URL for the phase's plan, for Paseo's in-app browser (which only opens http).
export async function openPhasePlan(input: { repo: string; epic: string }) {
  try {
    const phase = phaseOf(input);
    const rendered = renderPhasePlan(phase.epicDir, { ...phase, force: true });
    if (!rendered) throw new Error("This phase has no architecture.md yet. Plan its architecture first.");
    const url = await planUrl(`${phase.root}\n${phase.epicDir}`, {
      epicDir: phase.epicDir,
      render: () => renderPhasePlan(phase.epicDir, phase)?.file ?? null,
    });
    return { ok: true, error: null, warnings: rendered.warnings, url };
  } catch (cause) {
    return { ok: false, error: errorOf(cause), warnings: [], url: null };
  }
}

export async function refreshPhasePlan(input: { repo: string; epic: string }) {
  try {
    const phase = phaseOf(input);
    const result = await refreshPlanFromJira(phase.epicDir);
    syncPlanFromStories(phase.epicDir);
    renderPhasePlan(phase.epicDir, phase);
    return result;
  } catch (cause) {
    return { ok: false, error: errorOf(cause), keys: 0, changed: 0, missing: [] };
  }
}
