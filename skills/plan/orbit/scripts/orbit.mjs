#!/usr/bin/env node
// /orbit: run an initiative through the Orchestrator story loop from the command line.
// `new` and `status` read and write the repo's .harness files. `plan`, `start` and `stop` write a request to
// ~/.orchestrator/orbit.json, which the Orchestrator plugin picks up within about 5 seconds, then wait for
// ~/.orchestrator/orbit.result.json.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: orbit.mjs <command> [args] [--repo <path>] [--wait <seconds>]

  new <slug> "<outcome>" [--title "<title>"]   create the initiative (tracked locally, loop off)
  plan <slug> "<phase>" [--title "<title>"]    new phase and its architecture session
  start <slug>                                  start the story loop
  stop <slug>                                   stop the story loop
  status [slug]                                 phases, stories, and what waits on you`;

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value.`);
      flags[arg.slice(2)] = value;
      i++;
    } else positional.push(arg);
  }
  const [command, ...args] = positional;
  return { command, args, flags };
}

// The main checkout of the repo `cwd` is in: initiatives live there, not in a story's worktree.
export function mainCheckout(cwd) {
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" }).trim();
  // Real path: git answers a worktree with its resolved path, so /var and /private/var must agree.
  return dirname(realpathSync(isAbsolute(common) ? common : resolve(cwd, common)));
}

function frontmatter(text) {
  const block = /^---\n([\s\S]*?)\n---/.exec(text);
  const meta = {};
  for (const line of block ? block[1].split("\n") : []) {
    const at = line.indexOf(":");
    if (at > 0) meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return meta;
}

const read = (file) => (existsSync(file) ? readFileSync(file, "utf8") : "");
const dirs = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []);
const initiativesDir = (repo) => join(repo, ".harness", "initiatives");

function requireSlug(slug) {
  if (!slug || !SLUG.test(slug)) throw new Error(`Give a slug in lowercase letters, numbers and dashes, like "debrief".`);
  return slug;
}

export function createInitiative(repo, slug, outcome, title) {
  requireSlug(slug);
  if (!outcome?.trim()) throw new Error("Say what is true when the initiative is done, as the second argument.");
  const dir = join(initiativesDir(repo), slug);
  const file = join(dir, "initiative.md");
  if (existsSync(file)) throw new Error(`Initiative ${slug} already exists: ${file}`);
  mkdirSync(dir, { recursive: true });
  const heading = title?.trim() || slug;
  writeFileSync(file, `---\ntracker: local\n---\n\n# Initiative: ${heading}\n\n> **Slug:** \`${slug}\`\n\n## Outcome\n\n${outcome.trim()}\n`, "utf8");
  return file;
}

// What waits on the person steering: a plan to approve, a PR to merge, a blocked story.
function waitingOn(meta) {
  if (meta.status === "awaiting-approval") return "approve the plan";
  if (meta.status === "pr-open") return `merge PR #${meta.pr}${meta.ci ? ` (CI ${meta.ci})` : ""}`;
  if (meta.status === "blocked") return `blocked: ${meta.blocked_reason || "no reason given"}`;
  return null;
}

export function status(repo, only) {
  const slugs = only ? [requireSlug(only)] : dirs(initiativesDir(repo));
  if (!slugs.length) return `No initiatives in ${repo}. Create one with: orbit new <slug> "<outcome>"`;
  const out = [];
  const waiting = [];
  for (const slug of slugs) {
    const dir = join(initiativesDir(repo), slug);
    if (!existsSync(join(dir, "initiative.md"))) throw new Error(`No initiative ${slug} in ${repo}.`);
    const loop = frontmatter(read(join(dir, "initiative.md"))).loop || "off";
    out.push(`${slug} (loop ${loop})`);
    const phases = dirs(join(dir, "phases"));
    if (!phases.length) out.push("  no phases yet: orbit plan " + slug + ' "<phase>"');
    for (const phase of phases) {
      const storiesDir = join(dir, "phases", phase, "stories");
      const stories = existsSync(storiesDir) ? readdirSync(storiesDir).filter((f) => f.endsWith(".md")).sort() : [];
      const merged = stories.filter((f) => frontmatter(read(join(storiesDir, f))).status === "merged").length;
      out.push(`  ${phase}: ${merged}/${stories.length} merged`);
      for (const f of stories) {
        const meta = frontmatter(read(join(storiesDir, f)));
        out.push(`    ${(meta.id || f).padEnd(4)} ${(meta.status || "todo").padEnd(17)} ${meta.title || ""}`);
        const need = waitingOn(meta);
        if (need) waiting.push(`  ${slug} ${meta.id || f}: ${need}`);
      }
    }
  }
  out.push("", waiting.length ? "Waiting on you:" : "Nothing waits on you.", ...waiting);
  return out.join("\n");
}

// Writes one request for the plugin and waits for its answer. A request the plugin never picks up is removed,
// so it can't run later by surprise.
export async function request(body, { home = join(homedir(), ".orchestrator"), waitMs = 30_000, pollMs = 500 } = {}) {
  const file = join(home, "orbit.json");
  const resultFile = join(home, "orbit.result.json");
  if (existsSync(file)) throw new Error(`Another orbit request is still waiting: ${file}. Is Paseo running with the Orchestrator plugin?`);
  mkdirSync(home, { recursive: true });
  rmSync(resultFile, { force: true });
  writeFileSync(file, JSON.stringify(body) + "\n", "utf8");
  for (const end = Date.now() + waitMs; Date.now() < end; await sleep(pollMs)) {
    if (existsSync(resultFile)) {
      const result = JSON.parse(readFileSync(resultFile, "utf8"));
      rmSync(resultFile, { force: true });
      return result;
    }
  }
  rmSync(file, { force: true });
  throw new Error(`The Orchestrator plugin didn't answer in ${Math.round(waitMs / 1000)}s. Is Paseo running with the plugin loaded?`);
}

export function describe(action, result) {
  if (!result.ok) return `${action} failed: ${result.error}`;
  if (action === "plan") {
    const lines = [`Phase created: ${result.epic}`];
    lines.push(result.agentId ? `Architecture session started (${result.agentId}). Answer its questions, then say "lock".` : "The architecture session didn't start.");
    if (result.warning) lines.push(`Warning: ${result.warning}`);
    return lines.join("\n");
  }
  if (action === "start") {
    const started = result.started ?? [];
    return started.length ? `Loop on. Started: ${started.join(", ")}.` : `Loop on. Nothing started${result.reason ? `: ${result.reason}` : "."}`;
  }
  return "Loop off. Running steps finish; nothing new starts.";
}

async function main(argv) {
  const { command, args, flags } = parseArgs(argv);
  if (!command || command === "help") return console.log(USAGE);
  const repo = resolve(flags.repo ?? mainCheckout(process.cwd()));
  const waitMs = flags.wait ? Number(flags.wait) * 1000 : undefined;
  if (command === "new") return console.log(`Created ${createInitiative(repo, args[0], args[1], flags.title)}\nNext: orbit plan ${args[0]} "<phase>"`);
  if (command === "status") return console.log(status(repo, args[0]));
  if (command === "plan" || command === "start" || command === "stop") {
    const initiative = requireSlug(args[0]);
    const body = { action: command, repo, initiative };
    if (command === "plan") {
      if (!args[1]?.trim()) throw new Error('Name the phase, like: orbit plan debrief "Debrief v1"');
      Object.assign(body, { phase: args[1].trim(), title: flags.title ?? "" });
    }
    const result = await request(body, { waitMs });
    console.log(describe(command, result));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
}

// Run as a command, also through the symlink link-kit makes; imported by the test, it only exports.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
