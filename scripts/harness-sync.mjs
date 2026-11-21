// Stores a repo's .harness state in a PRIVATE git repo, so work can finish on another device:
//   node scripts/harness-sync.mjs push|pull [--remote URL] [--project P] [--harness D] [--force]
//
// .harness stays out of the project's own git (it holds plans, factory seats and notes that must not go public).
// Only initiatives/, factory/ and memory/ travel; replay/ is large and regenerable, so it stays local.
//
// Each device remembers the remote commit and the content hash it last synced (.harness/.sync-base). push refuses
// when the remote moved on, pull refuses when local has unpushed changes; --force overrides either.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

export const INCLUDE = ["initiatives", "factory", "memory"];
const BASE_FILE = ".sync-base";
const META_FILE = ".sync.json";
const BRANCH = "main";
const DEFAULT_REMOTE = "https://github.com/denmercs/orchestrator-state.git";

export function parseArgs(argv) {
  const opts = { mode: undefined, force: false, remote: process.env.HARNESS_STATE_REMOTE ?? DEFAULT_REMOTE, project: undefined, harness: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "push" || arg === "pull") opts.mode = arg;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--remote" || arg === "--project" || arg === "--harness") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      opts[arg.slice(2)] = value;
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (!opts.mode) throw new Error("say push or pull");
  return opts;
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function files(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(path);
    }
  };
  for (const folder of INCLUDE) if (existsSync(join(root, folder))) walk(join(root, folder));
  return out.map((path) => path.slice(root.length + 1));
}

export function hashTree(root) {
  const hash = createHash("sha256");
  for (const rel of files(root)) hash.update(rel).update("\0").update(readFileSync(join(root, rel))).update("\0");
  return hash.digest("hex");
}

function replaceTree(from, to) {
  for (const folder of INCLUDE) {
    rmSync(join(to, folder), { recursive: true, force: true });
    if (existsSync(join(from, folder))) cpSync(join(from, folder), join(to, folder), { recursive: true });
  }
}

function readBase(harness) {
  try {
    return JSON.parse(readFileSync(join(harness, BASE_FILE), "utf8"));
  } catch {
    return {};
  }
}

function writeBase(harness, commit) {
  writeFileSync(join(harness, BASE_FILE), JSON.stringify({ commit, hash: hashTree(harness) }) + "\n");
}

// A project's folder in the remote is its origin repo name, so every worktree of one repo shares one stored state.
export function projectName(cwd) {
  try {
    return basename(git(cwd, "remote", "get-url", "origin")).replace(/\.git$/, "");
  } catch {
    return basename(cwd);
  }
}

function defaultIsPrivate(remote) {
  const match = /github\.com[/:]([^/]+\/[^/.]+)/.exec(remote);
  if (!match) return true;
  return execFileSync("gh", ["repo", "view", match[1], "--json", "isPrivate", "--jq", ".isPrivate"], { encoding: "utf8" }).trim() === "true";
}

function openClone(cloneDir, remote) {
  if (!existsSync(join(cloneDir, ".git"))) {
    mkdirSync(cloneDir, { recursive: true });
    execFileSync("git", ["clone", "--quiet", remote, cloneDir], { stdio: "pipe" });
  }
  git(cloneDir, "fetch", "--quiet", "origin");
  const hasRemoteBranch = git(cloneDir, "branch", "-r", "--list", `origin/${BRANCH}`) !== "";
  if (hasRemoteBranch) git(cloneDir, "checkout", "--quiet", "-B", BRANCH, `origin/${BRANCH}`);
  else git(cloneDir, "checkout", "--quiet", "-B", BRANCH);
  return hasRemoteBranch ? git(cloneDir, "rev-parse", "HEAD") : "";
}

export function sync(opts, { log = console.log, isPrivate = defaultIsPrivate, now = () => new Date(), device = hostname() } = {}) {
  const harness = opts.harness ?? join(process.cwd(), ".harness");
  const project = opts.project ?? projectName(process.cwd());
  const cloneDir = opts.cloneDir ?? join(homedir(), ".orchestrator", "harness-state-clone");
  if (!isPrivate(opts.remote)) throw new Error(`${opts.remote} is not private; refusing to store .harness there`);

  const remoteHead = openClone(cloneDir, opts.remote);
  const base = readBase(harness);
  const stored = join(cloneDir, project);
  const meta = existsSync(join(stored, META_FILE)) ? JSON.parse(readFileSync(join(stored, META_FILE), "utf8")) : undefined;

  if (opts.mode === "push") {
    if (remoteHead !== (base.commit ?? "") && !opts.force) {
      const by = meta ? ` from ${meta.device} at ${meta.at}` : "";
      throw new Error(`remote has newer state${by}; pull first, or push --force to overwrite it`);
    }
    mkdirSync(stored, { recursive: true });
    replaceTree(harness, stored);
    writeFileSync(join(stored, META_FILE), JSON.stringify({ device, at: now().toISOString() }, null, 2) + "\n");
    git(cloneDir, "add", "-A", project);
    if (git(cloneDir, "status", "--porcelain") === "") {
      log("already up to date");
      writeBase(harness, remoteHead);
      return { changed: false };
    }
    git(cloneDir, "-c", "user.name=harness-sync", "-c", "user.email=harness-sync@localhost", "commit", "--quiet", "-m", `Sync ${project} .harness from ${device}`);
    git(cloneDir, "push", "--quiet", "origin", `HEAD:${BRANCH}`);
    writeBase(harness, git(cloneDir, "rev-parse", "HEAD"));
    log(`pushed ${project} (${files(stored).length} files)`);
    return { changed: true };
  }

  if (!existsSync(stored)) throw new Error(`nothing stored for ${project} yet; push from the device that has it`);
  if (!opts.force && files(harness).length > 0 && hashTree(harness) !== base.hash) {
    throw new Error("local .harness has changes that were never pushed; push first, or pull --force to overwrite them");
  }
  mkdirSync(harness, { recursive: true });
  replaceTree(stored, harness);
  writeBase(harness, remoteHead);
  log(`pulled ${project}${meta ? ` (from ${meta.device} at ${meta.at})` : ""}`);
  return { changed: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    sync(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
