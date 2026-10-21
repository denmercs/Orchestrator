import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_PIPELINE_FILE, parseRepoPipeline } from "../shared/repo-pipeline";
import { TESTING_SKILL, TESTING_SKILL_PATH, usesTestingSkill } from "../shared/testing-skill";
import { excludeHarness } from "./harness-layout";

// The repo's `"testingSkill"` from `.orchestrator/pipeline.json`, or undefined when it sets none (or the
// file is missing or broken, which keeps the built-in skill).
export function repoTestingSkill(cwd: string): string | boolean | undefined {
  const file = join(cwd, REPO_PIPELINE_FILE);
  if (!existsSync(file)) return undefined;
  return parseRepoPipeline(readFileSync(file, "utf8")).override?.testingSkill;
}

export type TestingSkill = { path?: string; warning?: string };

// The testing skill a step's prompt points at. Only Implement and Review get one: a repo's own file when
// `.orchestrator/pipeline.json` names one that exists, none when it says false, else the built-in skill
// written to TESTING_SKILL_PATH (under .harness/, which stays out of git). A named file that is missing
// falls back to the built-in one with a warning, so a typo never drops the guidance silently.
export async function prepareTestingSkill(worktree: string, step: string): Promise<TestingSkill> {
  if (!usesTestingSkill(step)) return {};
  const setting = repoTestingSkill(worktree);
  if (setting === false) return {};
  let warning: string | undefined;
  if (typeof setting === "string") {
    const own = join(worktree, setting);
    if (existsSync(own) && statSync(own).isFile()) return { path: setting };
    warning = `testingSkill ${setting} is not a file in this repo; using the built-in testing guidelines.`;
  }
  const file = join(worktree, TESTING_SKILL_PATH);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, TESTING_SKILL, "utf8");
  await excludeHarness(worktree);
  return warning ? { path: TESTING_SKILL_PATH, warning } : { path: TESTING_SKILL_PATH };
}
