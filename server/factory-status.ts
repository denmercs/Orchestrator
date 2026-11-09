import type { Ask } from "./claude-cli";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { factoryDir, readFactory } from "./factory-layout";

export type FactoryStatus = { answer: string } | { unavailable: string };

const SYSTEM = "You report on a software factory to someone listening. Answer in at most three short spoken sentences, from the reports only. Say what is happening and what is stuck. Do not read ids letter by letter, and do not invent anything the reports don't say.";

// A short text projection of the factory: the project's intent, each mission's outcome and per slice the fields that say
// where it is. Not the files: no spec, culture or frontmatter. Null when the factory has no missions and no project.
// `alive` says whether a seat agent's session is still live.
export async function factoryProjection(root: string, alive: (agent: string) => Promise<boolean>): Promise<string | null> {
  const factory = readFactory(root);
  if (!factory.project && factory.missions.length === 0) return null;
  const lines = [`Project: ${factory.project}`];
  for (const mission of factory.missions) {
    lines.push("", `Mission ${mission.id}: ${mission.outcome}`);
    for (const { id, state, proof } of mission.slices) {
      const agent = state.agent ? ((await alive(state.agent)) ? "alive" : "dead") : "none";
      lines.push(
        `- ${id}: phase ${state.phase}, run ${state.run ? "on" : "off"}${state.ready ? `, ready ${state.ready}` : ""}, attempt ${state.attempt}, proof ${proof ? "yes" : "no"}, agent ${agent}`,
      );
    }
  }
  return lines.join("\n");
}

// One repo's report: its digest when the tick has written one, else the projection (a factory before its first pass), else
// null (no factory, so nothing to say). Labelled by the repo folder name.
async function repoReport(root: string, alive: (agent: string) => Promise<boolean>): Promise<string | null> {
  const file = join(factoryDir(root), "digest.md");
  const text = existsSync(file) ? readFileSync(file, "utf8").trim() : await factoryProjection(root, alive);
  return text ? `Repo ${basename(root)}:\n${text}` : null;
}

// One cheap answer to "where are we" across repos: each repo's digest through the one-shot model. It only reads files and
// sends nothing, and wakes no manager. `{ unavailable }` carries the reason when the one-shot can't run or fails, so the
// caller can fall back and say why; null when no repo has a factory, so the session list answers.
export async function factoryStatus(
  roots: string[],
  ports: { ask: Ask; unavailable: () => Promise<string | null>; alive: (agent: string) => Promise<boolean> },
): Promise<FactoryStatus | null> {
  const reports: string[] = [];
  for (const root of roots) {
    const report = await repoReport(root, ports.alive);
    if (report) reports.push(report);
  }
  if (reports.length === 0) return null;
  const reason = await ports.unavailable();
  if (reason) return { unavailable: reason };
  try {
    const { text } = await ports.ask(SYSTEM, reports.join("\n\n"));
    return { answer: text.trim() };
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
}
