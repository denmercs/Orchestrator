import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The plugin ships its own skills under <plugin>/skills/. The kit source is this folder, exposed
// to the Story pipeline as a built-in source so our default phase skills (like story-plan) are
// always available without the user connecting anything. Resolved from this file's location so it
// moves with the plugin's install path.
export const KIT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills");

export function kitDir(): string {
  if (!existsSync(KIT_DIR)) {
    throw new Error(`Kit skills folder missing: ${KIT_DIR}`);
  }
  return KIT_DIR;
}
