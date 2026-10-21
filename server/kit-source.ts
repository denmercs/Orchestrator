import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The plugin ships its own skills under <plugin>/skills/. The kit source is this folder, exposed
// to the Story pipeline as a built-in source so our default phase skills (like story-plan) are
// always available without the user connecting anything. Paseo bundles the plugin as CJS, which
// has no module URL, so the folder is found from where Paseo says the plugin lives:
// `$PASEO_HOME/config.json` → `plugins.orchestrator.path` (any install kind). Failing that, the git
// install layout `plugins/orchestrator/<install id>/checkout`, newest first.
function configuredPath(home: string): string | null {
  try {
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { plugins?: Record<string, { path?: unknown }> };
    const path = config.plugins?.orchestrator?.path;
    return typeof path === "string" && path ? path : null;
  } catch {
    return null;
  }
}

export function kitDir(): string {
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  const configured = configuredPath(home);
  if (configured && existsSync(join(configured, "skills"))) return join(configured, "skills");
  const root = join(home, "plugins", "orchestrator");
  const found = (existsSync(root) ? readdirSync(root) : [])
    .map((id) => join(root, id, "checkout", "skills"))
    .filter((dir) => existsSync(dir))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!found[0]) {
    throw new Error(`Kit skills folder missing under ${root}`);
  }
  return found[0];
}
