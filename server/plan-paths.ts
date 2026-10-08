import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Reads the brief in a story's `## Plan`: the paths named on its
// Files and Calls lines, so the loop can tell a later step which of them aren't on disk.

export type PlanPath = { path: string; isNew: boolean };

const LABEL = /^\s*(?:[-*]\s+)?(?:\*\*)?(Files|Calls|Commands|Out of scope):(?:\*\*)?/i;
const EXTENSION = /\.(?:[cm]?[jt]sx?|json|md|mdc|css|scss|html|ya?ml|sh|txt|toml)$/;
// A backticked span, a `(new)` marker, or a bare word.
const TOKEN = /`([^`]+)`|\(new\)|[^\s,;`]+/g;

// Lines under a Files or Calls label belong to it until the next label, a heading or a blank line.
// A backticked path has a `/` or a file extension; a bare one needs the extension, so prose like
// `and/or` isn't read as a path. `:line` and trailing punctuation are dropped,
// and anything with `(` (a call like `foo()`) is skipped. `(new)` marks the path just before it.
export function planPaths(plan: string): PlanPath[] {
  const paths: PlanPath[] = [];
  let inPathLabel = false;
  for (const line of plan.split("\n")) {
    const label = LABEL.exec(line);
    if (label) inPathLabel = /^(files|calls)$/i.test(label[1]);
    else if (!line.trim() || line.trimStart().startsWith("#")) inPathLabel = false;
    if (!inPathLabel) continue;

    const body = label ? line.slice(label[0].length) : line.replace(/^\s*[-*]\s+/, "");
    let last: PlanPath | undefined;
    for (const [token, quoted] of body.matchAll(TOKEN)) {
      if (token === "(new)") {
        if (last) last.isNew = true;
        continue;
      }
      last = undefined;
      const path = asPath(quoted ?? token, quoted !== undefined);
      if (path) paths.push((last = { path, isNew: false }));
    }
  }
  return paths;
}

// The paths that should already exist but don't: `(new)` ones are skipped, relative paths resolve
// against the worktree, and each path is reported once.
export function missingPaths(paths: PlanPath[], worktree: string): string[] {
  const missing = new Set<string>();
  for (const { path, isNew } of paths) {
    if (!isNew && !existsSync(resolve(worktree, path))) missing.add(path);
  }
  return [...missing];
}

function asPath(token: string, quoted: boolean): string | undefined {
  if (token.includes("(") || /\s/.test(token)) return undefined;
  const path = token.replace(/[.,;:)]+$/, "").replace(/(?::\d+)+$/, "");
  if (!/\w/.test(path) || path.includes(":")) return undefined;
  return EXTENSION.test(path) || (quoted && path.includes("/")) ? path : undefined;
}
