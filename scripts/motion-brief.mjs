// Writes a Motion brief for a diff in the current repo, then prints where motion.md is:
//   node --import ./test-support/register.mjs scripts/motion-brief.mjs [--base main] [--head HEAD] [--out DIR] [--json FILE]
// --json skips the writer agent and re-checks an edited motion.json against the same diff.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const FLAGS = { "--base": "base", "--head": "head", "--out": "out", "--json": "json" };

export function parseArgs(argv) {
  const opts = { base: "main", head: "HEAD", out: undefined, json: undefined };
  for (let i = 0; i < argv.length; i++) {
    const key = FLAGS[argv[i]];
    if (!key) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argv[i]} needs a value`);
    opts[key] = value;
    i++;
  }
  return opts;
}

// Outside the repo, one folder per head commit.
const defaultOut = (root, head) =>
  join(homedir(), ".orchestrator", "motion", basename(root), execFileSync("git", ["rev-parse", "--short", head], { cwd: root, encoding: "utf8" }).trim());

export async function run(argv, { brief, log = console.log, root = process.cwd() } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    log(`${error.message}\nusage: motion-brief.mjs [--base main] [--head HEAD] [--out DIR] [--json FILE]`);
    throw Object.assign(error, { exitCode: 2 });
  }
  const motionBrief = brief ?? (await import("../server/motion-brief.ts")).motionBrief;
  const write = opts.json ? async () => ({ text: readFileSync(opts.json, "utf8"), costUsd: 0 }) : undefined;
  const input = { worktree: root, base: opts.base, head: opts.head, outDir: opts.out ?? defaultOut(root, opts.head) };
  const result = await motionBrief(input, write);
  log(result.file ? `motion.md: ${result.file}` : "no motion.md written");
  if (result.cut.length) log(`cut for size: ${result.cut.map((c) => `${c.path} (${c.reason})`).join(", ")}`);
  for (const problem of result.problems) log(`problem: ${problem}`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run(process.argv.slice(2)).catch((error) => {
    process.exitCode = error.exitCode ?? 1;
    if (!error.exitCode) console.error(error);
  });
}
