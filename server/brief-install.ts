import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { briefScript } from "../shared/brief";
import { excludeHarness } from "./harness-layout";

// Writes the step's `.harness/bin/brief` wrapper into the worktree and keeps `.harness/` out of git.
export async function installBrief(worktree: string, step: string): Promise<void> {
  const bin = join(worktree, ".harness", "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "brief");
  writeFileSync(script, briefScript(step), "utf8");
  chmodSync(script, 0o755);
  await excludeHarness(worktree);
}
