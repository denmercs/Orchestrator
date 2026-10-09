// Seeds .harness/memory for the current repo:
//   node --import ./test-support/register.mjs scripts/seed-memory.mjs [--as-of D] [--cap 3] [--exclude S]
import { pathToFileURL } from "node:url";

const DEFAULT_CAP = 3;

export function parseArgs(argv) {
  const opts = { asOf: undefined, costCap: DEFAULT_CAP, excludeStory: undefined };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === "--as-of") opts.asOf = value;
    else if (argv[i] === "--cap") opts.costCap = Number(value);
    else if (argv[i] === "--exclude") opts.excludeStory = value;
    else continue;
    i++;
  }
  return opts;
}

export async function run(argv, { analyze, log = console.log, root = process.cwd() } = {}) {
  const run = analyze ?? (await import("../server/repo-analyzer.ts")).analyze;
  const opts = parseArgs(argv);
  log(`cost cap $${opts.costCap.toFixed(2)}`);
  // analyze logs the cap itself; it was just printed, so drop that line.
  const result = await run(root, { ...opts, log: (line) => (line.startsWith("cost cap ") ? undefined : log(line)) });
  log(`written ${result.written.length}, removed ${result.removed.length}, skipped ${result.skipped.length}`);
  log(`spent $${result.spentUsd.toFixed(4)}`);
  if (result.stopped === "cap") log("stopped at cap");
  if (result.stopped === "error") log("stopped: error");
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run(process.argv.slice(2));
}
