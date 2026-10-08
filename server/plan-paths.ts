// Reads the brief in a story's `## Plan`: the paths named on its
// Files and Calls lines, so the loop can tell a later step which of them aren't on disk.

export type PlanPath = { path: string; isNew: boolean };

const LABEL = /^\s*(?:[-*]\s+)?(?:\*\*)?(Files|Calls|Commands|Out of scope):(?:\*\*)?/i;
const EXTENSION = /\.(?:[cm]?[jt]sx?|json|md|mdc|css|scss|html|ya?ml|sh|txt|toml)$/;
// A backticked span, a `(new)` marker, or a bare word.
const TOKEN = /`([^`]+)`|\(new\)|[^\s,;`]+/g;

// Lines under a Files or Calls label belong to it until the next label, a heading or a blank line.
// A path is a token with a `/` or a file extension; `:line` and trailing punctuation are dropped,
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
      const path = asPath(quoted ?? token);
      if (path) paths.push((last = { path, isNew: false }));
    }
  }
  return paths;
}

function asPath(token: string): string | undefined {
  if (token.includes("(") || /\s/.test(token)) return undefined;
  const path = token.replace(/[.,;:)]+$/, "").replace(/(?::\d+)+$/, "");
  if (!/\w/.test(path) || path.includes(":")) return undefined;
  return path.includes("/") || EXTENSION.test(path) ? path : undefined;
}
