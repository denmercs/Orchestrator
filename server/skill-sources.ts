import { execFile } from "node:child_process";
import { appendFile, cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { MACHINE_SOURCE, type CatalogSkill, type SkillRef, type SkillSource } from "../shared/belt";

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
const SCAN_DEPTH = 5;

// Checkouts of git sources. Folder sources are read in place.
export const SOURCES_ROOT = join(homedir(), ".orchestrator", "skill-sources");

type Found = { name: string; kind: "skill" | "command"; path: string };
type Location = { type: "git"; url: string } | { type: "folder"; path: string };

const locks = new Map<string, Promise<unknown>>();

function withLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  locks.set(id, next);
  return next;
}

async function git(cwd: string, args: string[]) {
  const { stdout } = await run("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

export function parseLocation(input: string): Location {
  const value = input.trim();
  if (!value || value.startsWith("-")) {
    throw new Error("Enter owner/repo, a git URL, or an absolute folder path.");
  }
  if (value.startsWith("~/") || isAbsolute(value)) {
    return { type: "folder", path: resolve(value.startsWith("~/") ? join(homedir(), value.slice(2)) : value) };
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) {
    return { type: "git", url: `https://github.com/${value.replace(/\.git$/, "")}.git` };
  }
  if (/^(https:\/\/|ssh:\/\/|git@)[^\s]+$/.test(value)) {
    return { type: "git", url: value };
  }
  throw new Error("Enter owner/repo, a git URL, or an absolute folder path.");
}

export function sourceId(location: string) {
  const slug = location
    .trim()
    .replace(/^https?:\/\/|^ssh:\/\/|^git@/, "")
    .replace(/\.git$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(-60) || "source";
}

function sourceLabel(location: Location) {
  if (location.type === "folder") {
    return basename(location.path);
  }
  const match = location.url.match(/([^/:]+)\/([^/]+?)(\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : location.url;
}

function checkoutDir(id: string) {
  const dir = join(SOURCES_ROOT, id);
  if (!dir.startsWith(SOURCES_ROOT + sep)) {
    throw new Error("Invalid source id.");
  }
  return dir;
}

async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function isDirectory(path: string) {
  return stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

async function hasCommit(dir: string, sha: string) {
  return git(dir, ["cat-file", "-e", `${sha}^{commit}`]).then(
    () => true,
    () => false,
  );
}

async function clone(url: string, dir: string) {
  await mkdir(SOURCES_ROOT, { recursive: true });
  await rm(dir, { recursive: true, force: true });
  await run("git", ["clone", "--quiet", "--", url, dir], { timeout: GIT_TIMEOUT_MS });
}

// Make the source's files match its pin and return the directory to read.
async function materialise(source: SkillSource) {
  const location = parseLocation(source.location);
  if (location.type === "folder") {
    if (!(await isDirectory(location.path))) {
      throw new Error(`Folder not found: ${location.path}`);
    }
    return location.path;
  }
  const dir = checkoutDir(source.id);
  return withLock(source.id, async () => {
    if (!(await exists(join(dir, ".git")))) {
      await clone(location.url, dir);
    }
    if (source.pin) {
      if (!(await hasCommit(dir, source.pin))) {
        await git(dir, ["fetch", "--quiet", "origin"]);
      }
      const head = await git(dir, ["rev-parse", "HEAD"]);
      if (head !== source.pin) {
        await git(dir, ["checkout", "--quiet", "--detach", source.pin]);
      }
    }
    return dir;
  });
}

async function scan(root: string): Promise<Found[]> {
  const found = new Map<string, Found>();

  async function walk(dir: string, depth: number) {
    if (await exists(join(dir, "SKILL.md"))) {
      const name = basename(dir);
      if (!found.has(name)) {
        found.set(name, { name, kind: "skill", path: dir });
      }
      return;
    }
    if (depth >= SCAN_DEPTH) {
      return;
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory() || (entry.isSymbolicLink() && (await isDirectory(path)))) {
        await walk(path, depth + 1);
      }
    }
  }

  await walk(root, 0);
  for (const commands of [join(root, "commands"), join(root, ".claude", "commands")]) {
    for (const file of await readdir(commands).catch(() => [] as string[])) {
      const name = file.replace(/\.md$/, "");
      if (file.endsWith(".md") && !found.has(name)) {
        found.set(name, { name, kind: "command", path: join(commands, file) });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function scanMachine(): Promise<Found[]> {
  const home = homedir();
  const found = new Map<string, Found>();
  for (const root of [join(home, ".claude", "skills"), join(home, ".agents", "skills")]) {
    for (const name of await readdir(root).catch(() => [] as string[])) {
      const dir = join(root, name);
      if (!found.has(name) && (await exists(join(dir, "SKILL.md")))) {
        found.set(name, { name, kind: "skill", path: dir });
      }
    }
  }
  // ss-* phase entry points are slash commands, not skill folders.
  const commands = join(home, ".claude", "commands");
  for (const file of await readdir(commands).catch(() => [] as string[])) {
    const name = file.replace(/\.md$/, "");
    if (file.endsWith(".md") && !found.has(name)) {
      found.set(name, { name, kind: "command", path: join(commands, file) });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadCatalog(sources: SkillSource[]) {
  const skills: CatalogSkill[] = (await scanMachine()).map((s) => ({
    name: s.name,
    folder: s.name,
    description: "",
    source: MACHINE_SOURCE,
    kind: s.kind,
  }));
  const statuses = [];
  for (const source of sources) {
    try {
      const dir = await materialise(source);
      const found = await scan(dir);
      if (source.enabled) {
        skills.push(
          ...found.map((s) => ({ name: s.name, folder: s.name, description: "", source: source.id, kind: s.kind })),
        );
      }
      statuses.push({ id: source.id, ok: true, error: null, commit: source.pin, skillCount: found.length });
    } catch (error) {
      statuses.push({ id: source.id, ok: false, error: message(error), commit: source.pin, skillCount: 0 });
    }
  }
  return { skills, sources: statuses };
}

export async function addSource(input: string) {
  const location = parseLocation(input);
  const id = sourceId(input);
  const label = sourceLabel(location);
  try {
    if (location.type === "folder") {
      if (!(await isDirectory(location.path))) {
        throw new Error(`Folder not found: ${location.path}`);
      }
      const found = await scan(location.path);
      return { ok: true, error: null, id, label, location: location.path, pin: null, skillCount: found.length };
    }
    const dir = checkoutDir(id);
    return await withLock(id, async () => {
      await clone(location.url, dir);
      const pin = await git(dir, ["rev-parse", "HEAD"]);
      const found = await scan(dir);
      return { ok: true, error: null, id, label, location: input.trim(), pin, skillCount: found.length };
    });
  } catch (error) {
    return { ok: false, error: message(error), id, label, location: input.trim(), pin: null, skillCount: 0 };
  }
}

// Fetch without moving the pin; report what an Update would bring in.
export async function checkSource(source: SkillSource) {
  const empty = { head: null, commits: [], changedSkills: [] };
  try {
    const location = parseLocation(source.location);
    if (location.type === "folder") {
      return { ok: true, error: null, ...empty };
    }
    const dir = await materialise(source);
    return await withLock(source.id, async () => {
      await git(dir, ["fetch", "--quiet", "origin"]);
      const head = await git(dir, ["rev-parse", "origin/HEAD"]).catch(() =>
        git(dir, ["rev-parse", "FETCH_HEAD"]),
      );
      if (!source.pin || head === source.pin) {
        return { ok: true, error: null, head, commits: [], changedSkills: [] };
      }
      const log = await git(dir, ["log", "--max-count=50", "--format=%H%x09%s", `${source.pin}..${head}`]);
      const commits = log
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha = "", ...rest] = line.split("\t");
          return { sha, subject: rest.join("\t") };
        });
      const changed = (await git(dir, ["diff", "--name-only", source.pin, head])).split("\n").filter(Boolean);
      const known = (await scan(dir)).filter((s) => s.kind === "skill").map((s) => relative(dir, s.path));
      const names = new Set<string>();
      for (const path of changed) {
        const skillDir = known.find((k) => path === k || path.startsWith(`${k}/`));
        if (skillDir) {
          names.add(basename(skillDir));
        } else if (basename(path) === "SKILL.md") {
          names.add(basename(dirname(path)));
        } else if (/(^|\/)commands\/[^/]+\.md$/.test(path)) {
          names.add(basename(path, ".md"));
        }
      }
      return { ok: true, error: null, head, commits, changedSkills: [...names].sort() };
    });
  } catch (error) {
    return { ok: false, error: message(error), ...empty };
  }
}

export async function removeSourceCheckout(id: string) {
  await withLock(id, () => rm(checkoutDir(id), { recursive: true, force: true }));
  return { ok: true };
}

// What an attachment carries: SKILL.md's body plus absolute paths to the skill's other files
// in the pinned checkout or folder. `commit` is the source's pin (null for folder sources).
export type SkillContent =
  | { name: string; description: string; body: string; files: string[]; commit: string | null }
  | { error: string };

// Stub until S2.
export async function readSkill(_ref: SkillRef, _sources: SkillSource[]): Promise<SkillContent> {
  return { error: "Not implemented." };
}

// Copy the phase's skills from connected sources into the story worktree, where the agent
// picks them up as project skills. Machine skills are already global and are skipped.
export async function installSkills(cwd: string, refs: SkillRef[], sources: SkillSource[]) {
  const warnings: string[] = [];
  const excludes: string[] = [];
  for (const ref of refs) {
    if (ref.source === MACHINE_SOURCE) {
      continue;
    }
    const source = sources.find((s) => s.id === ref.source);
    if (!source || !source.enabled) {
      warnings.push(`${ref.name}: source "${ref.source}" is not connected or is off.`);
      continue;
    }
    let entry: Found | undefined;
    try {
      entry = (await scan(await materialise(source))).find((s) => s.name === ref.name);
    } catch (error) {
      warnings.push(`${ref.name}: ${message(error)}`);
      continue;
    }
    if (!entry) {
      warnings.push(`${ref.name}: not found in ${source.label}.`);
      continue;
    }
    const targets =
      entry.kind === "skill"
        ? [".claude/skills", ".cursor/skills", ".agents/skills"].map((d) => `${d}/${entry.name}`)
        : [".claude/commands", ".cursor/commands"].map((d) => `${d}/${entry.name}.md`);
    for (const target of targets) {
      if (await isTracked(cwd, target)) {
        warnings.push(`${target} is committed in this repo; left it alone.`);
        continue;
      }
      const path = join(cwd, target);
      await rm(path, { recursive: true, force: true });
      await mkdir(dirname(path), { recursive: true });
      await cp(entry.path, path, { recursive: true, dereference: true });
      excludes.push(`/${target}`);
    }
  }
  if (excludes.length > 0) {
    await addGitExcludes(cwd, excludes).catch((error) => {
      warnings.push(`Could not hide copied skills from git: ${message(error)}`);
    });
  }
  return warnings;
}

async function isTracked(cwd: string, path: string) {
  return git(cwd, ["ls-files", "--error-unmatch", "--", path]).then(
    () => true,
    () => false,
  );
}

async function addGitExcludes(cwd: string, lines: string[]) {
  const excludePath = resolve(cwd, await git(cwd, ["rev-parse", "--git-path", "info/exclude"]));
  const current = await readFile(excludePath, "utf8").catch(() => "");
  const have = new Set(current.split("\n").map((line) => line.trim()));
  const missing = lines.filter((line) => !have.has(line));
  if (missing.length === 0) {
    return;
  }
  await mkdir(dirname(excludePath), { recursive: true });
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await appendFile(excludePath, `${prefix}# Orchestrator skills (copied per story)\n${missing.join("\n")}\n`);
}

function message(error: unknown) {
  if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" && error.stderr.trim()) {
    return error.stderr.trim().split("\n").slice(-1)[0] ?? "git failed";
  }
  return error instanceof Error ? error.message : String(error);
}
