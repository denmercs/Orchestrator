// The diff behind a Motion brief (see CONTEXT.md, "Motion brief"): `git diff base...head` parsed per
// file, trimmed to a size the writer agent can take, and laid out as the agent's only input. Pure.

export type DiffFile = {
  path: string;
  status: "A" | "M" | "D";
  added: string[]; // the + lines, without the +
  removed: string[];
  addedNames: string[]; // functions and exports
  removedNames: string[];
  addedTests: string[]; // test( / it( / describe( names
  text: string; // the file's whole chunk of the diff
};

export type CutFile = { path: string; reason: "generated" | "test" | "size" };
export type TrimmedDiff = { kept: DiffFile[]; cut: CutFile[] };

// Characters of diff the writer agent gets, file chunks only.
export const MOTION_DIFF_CAP = 60_000;

const NAME_PATTERNS = [
  /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/,
  /\b(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
  /\bclass\s+([A-Za-z_$][\w$]*)/,
  /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^\s*def\s+([A-Za-z_]\w*)/,
];
const TEST_PATTERN = /\b(?:test|it|describe)\(\s*(["'`])(.*?)\1/g;

const unique = (items: string[]) => [...new Set(items)];
const names = (lines: string[]) =>
  unique(lines.flatMap((line) => {
    for (const pattern of NAME_PATTERNS) {
      const match = pattern.exec(line);
      if (match) return [match[1]!];
    }
    return [];
  }));
const tests = (lines: string[]) => unique(lines.flatMap((line) => [...line.matchAll(TEST_PATTERN)].map((m) => m[2]!)));

function fileOf(lines: string[]): DiffFile {
  const header = lines[0]!;
  let status: DiffFile["status"] = "M";
  // "diff --git a/P b/P": P from the header for a binary file, which has no ---/+++ lines.
  const rest = header.slice("diff --git ".length);
  let path = rest.slice(2, 2 + (rest.length - 5) / 2);
  const added: string[] = [];
  const removed: string[] = [];
  let inHunk = false;
  for (const line of lines.slice(1)) {
    if (!inHunk) {
      if (line.startsWith("new file mode")) status = "A";
      else if (line.startsWith("deleted file mode")) status = "D";
      else if (line.startsWith("+++ b/")) path = line.slice(6);
      else if (line.startsWith("--- a/") && status === "D") path = line.slice(6);
      else if (line.startsWith("@@")) inHunk = true;
      continue;
    }
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
  }
  return {
    path,
    status,
    added,
    removed,
    addedNames: names(added),
    removedNames: names(removed),
    addedTests: tests(added),
    text: lines.join("\n"),
  };
}

export function parseDiff(diff: string): DiffFile[] {
  const files: string[][] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) files.push([line]);
    else files.at(-1)?.push(line);
  }
  return files.map(fileOf);
}

const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|[^/]+\.lock|[^/]+\.min\.(js|css)|[^/]+\.map|[^/]+\.snap)$|(^|\/)(dist|build|generated|__generated__)\//;
const TEST = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

// Cuts whole files until the chunks fit `cap`: lockfiles and generated files first, then tests, then
// the largest remaining files, each group largest first. Order of the kept files is the diff's.
export function trimDiff(files: DiffFile[], cap = MOTION_DIFF_CAP): TrimmedDiff {
  let size = files.reduce((n, f) => n + f.text.length, 0);
  const cut: CutFile[] = [];
  const out = new Set<DiffFile>();
  const reasonOf = (f: DiffFile): CutFile["reason"] => (GENERATED.test(f.path) ? "generated" : TEST.test(f.path) ? "test" : "size");
  for (const reason of ["generated", "test", "size"] as const) {
    const group = files.filter((f) => reasonOf(f) === reason || reason === "size").filter((f) => !out.has(f));
    for (const file of group.sort((a, b) => b.text.length - a.text.length)) {
      if (size <= cap) break;
      out.add(file);
      size -= file.text.length;
      cut.push({ path: file.path, reason });
    }
  }
  return { kept: files.filter((f) => !out.has(f)), cut };
}

const summaryLine = (f: DiffFile) =>
  [
    `${f.status} ${f.path} +${f.added.length} -${f.removed.length}`,
    f.addedNames.length ? `added: ${f.addedNames.join(", ")}` : "",
    f.removedNames.length ? `removed: ${f.removedNames.join(", ")}` : "",
    f.addedTests.length ? `tests: ${f.addedTests.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");

// The writer agent's input: a summary of every file, the cut list, then the kept chunks.
export function diffForAgent(trimmed: TrimmedDiff, all: DiffFile[]): string {
  const plus = all.reduce((n, f) => n + f.added.length, 0);
  const minus = all.reduce((n, f) => n + f.removed.length, 0);
  return [
    `Files changed (${all.length}), lines +${plus} -${minus}:`,
    ...all.map(summaryLine),
    ...(trimmed.cut.length ? ["", `Left out for size (not shown below): ${trimmed.cut.map((c) => `${c.path} (${c.reason})`).join(", ")}`] : []),
    "",
    ...trimmed.kept.map((f) => f.text),
  ].join("\n");
}
