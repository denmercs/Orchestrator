#!/usr/bin/env node
// Counts the lines a pull request changes (added + deleted), split into source, tests and skipped
// (lockfiles, generated files, anything matching --skip). Only source counts toward the PR size limit.
//
//   node count-lines.mjs <base> [head] [--skip <glob>]...
//
// <base> and <head> are compared with `git diff --numstat <base>...<head>` (head defaults to HEAD).

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TARGET = 500;
export const LIMIT = 1000;

const TEST = [
  /(^|\/)(__tests__|__snapshots__|__mocks__|tests?|spec|e2e)\//,
  /\.(test|spec)\.[^/]+$/,
  /\.snap$/,
  /_test\.(go|py|rb|exs?)$/,
  /(^|\/)test_[^/]+\.py$/,
  /[^/](Tests?|Spec)\.(java|kt|swift|cs|scala)$/,
];

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Gemfile.lock",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "composer.lock",
  "go.sum",
  "Podfile.lock",
  "Package.resolved",
  "gradle.lockfile",
]);

const GENERATED = [
  /(^|\/)(__generated__|generated)\//,
  /\.generated\.[^/]+$/,
  /\.g\.[^/]+$/,
  /\.min\.(js|css)$/,
  /\.pb\.[^/]+$/,
  /_pb2\.py$/,
  /\.map$/,
];

// `*` matches within one path segment, `**` across segments, `?` one character. A pattern with no `/`
// matches the file name in any folder.
export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        out += "(?:.*/)?";
      } else {
        out += ".*";
      }
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(glob.includes("/") ? `^${out}$` : `(^|/)${out}$`);
}

export function classify(path, skip = []) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (LOCKFILES.has(name) || GENERATED.some((re) => re.test(path)) || skip.some((re) => re.test(path))) {
    return "skipped";
  }
  return TEST.some((re) => re.test(path)) ? "tests" : "source";
}

// Parses `git diff --numstat --no-renames -z` output: one "added\tdeleted\tpath" record per NUL, paths
// unquoted. Newline-separated output (no -z) is read too. Binary files ("-\t-\tpath") count as zero lines.
export function countLines(numstat, skipGlobs = []) {
  const skip = skipGlobs.map(globToRegExp);
  const totals = { source: 0, tests: 0, skipped: 0 };
  const files = { source: [], tests: [], skipped: [] };
  for (const line of numstat.split(/\0|\n/)) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) continue;
    const [, added, deleted, path] = match;
    const lines = (added === "-" ? 0 : Number(added)) + (deleted === "-" ? 0 : Number(deleted));
    const kind = classify(path, skip);
    totals[kind] += lines;
    files[kind].push({ path, lines });
  }
  return { ...totals, files };
}

export function verdict(source) {
  if (source > LIMIT) return `over ${LIMIT}: justify in the PR body why this is one idea, or split it`;
  if (source > TARGET) return `over ${TARGET}: check it is still one idea`;
  return `within ${TARGET}`;
}

export function report(counts) {
  const top = [...counts.files.source].sort((a, b) => b.lines - a.lines).slice(0, 5);
  return [
    `source  ${counts.source}`,
    `tests   ${counts.tests}`,
    `skipped ${counts.skipped} (lockfiles, generated, --skip)`,
    `verdict ${verdict(counts.source)}`,
    ...(top.length ? ["", "largest source files:", ...top.map((f) => `  ${f.lines}\t${f.path}`)] : []),
  ].join("\n");
}

export function parseArgs(argv) {
  const positional = [];
  const skip = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--skip") {
      if (argv[i + 1] === undefined) throw new Error("--skip needs a glob");
      skip.push(argv[++i]);
    } else if (arg.startsWith("--skip=")) skip.push(arg.slice("--skip=".length));
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length < 1 || positional.length > 2) {
    throw new Error("usage: count-lines.mjs <base> [head] [--skip <glob>]...");
  }
  return { base: positional[0], head: positional[1] ?? "HEAD", skip };
}

// Run as a command, including through a symlink (~/.claude/skills links to this folder).
function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    const { base, head, skip } = parseArgs(process.argv.slice(2));
    const numstat = execFileSync("git", ["diff", "--numstat", "--no-renames", "-z", `${base}...${head}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    console.log(report(countLines(numstat, skip)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
