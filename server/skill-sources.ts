import { execFile } from "node:child_process";
import { appendFile, cp, mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { MACHINE_SOURCE, type CatalogSkill, type SkillRef, type SkillSource } from "../shared/pipeline";

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
const SCAN_DEPTH = 5;

// Checkouts of git sources. Folder sources are read in place.
export const SOURCES_ROOT = join(homedir(), ".orchestrator", "skill-sources");

// `name` is the SKILL.md frontmatter name when set; `folder` is the skill folder or command file name.
type Found = { name: string; folder: string; description: string; kind: "skill" | "command"; path: string };
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

// Reads the top-level `name` and `description` of a SKILL.md or command file. Values may be
// plain, quoted, or a `>` / `|` block scalar; they come back trimmed. `body` is everything after
// the closing `---`, or the whole text when there is no frontmatter.
export function readFrontmatter(text: string): { name?: string; description?: string; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) {
    return { body: text };
  }
  const fields: { name?: string; description?: string } = {};
  const lines = (match[1] ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const key = lines[i]?.match(/^(name|description):[ \t]*(.*)$/);
    if (!key) {
      continue;
    }
    const raw = (key[2] ?? "").trim();
    const more: string[] = [];
    while (i + 1 < lines.length && /^([ \t]|$)/.test(lines[i + 1] ?? "")) {
      more.push(lines[++i] ?? "");
    }
    fields[key[1] as "name" | "description"] = scalar(raw, more);
  }
  return { ...fields, body: text.slice(match[0].length) };
}

function scalar(raw: string, more: string[]) {
  if (/^\|[+-]?$/.test(raw)) {
    const indent = Math.min(...more.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
    return more.map((l) => l.slice(indent)).join("\n").trim();
  }
  if (/^>[+-]?$/.test(raw) || !/^["']/.test(raw)) {
    // Folded: lines join with spaces, blank lines become newlines. A plain value ends at " #".
    const plain = raw.replace(/[ \t]+#.*$/, "");
    const parts = (/^>/.test(raw) ? more : [plain, ...more]).map((l) => l.trim());
    return parts
      .join("\n")
      .replace(/([^\n])\n(?=[^\n])/g, "$1 ")
      .replace(/\n\n/g, "\n")
      .trim();
  }
  const quoted = [raw, ...more.map((l) => l.trim())].join(" ");
  if (quoted.startsWith('"')) {
    try {
      return String(JSON.parse(quoted));
    } catch {
      return quoted.slice(1, -1);
    }
  }
  return quoted.slice(1, -1).replace(/''/g, "'");
}

async function describe(file: string) {
  return readFrontmatter(await readFile(file, "utf8").catch(() => ""));
}

async function skillAt(dir: string): Promise<Found> {
  const meta = await describe(join(dir, "SKILL.md"));
  const folder = basename(dir);
  return { name: meta.name || folder, folder, description: meta.description ?? "", kind: "skill", path: dir };
}

async function commandAt(path: string): Promise<Found> {
  const folder = basename(path, ".md");
  return { name: folder, folder, description: (await describe(path)).description ?? "", kind: "command", path };
}

async function scan(root: string): Promise<Found[]> {
  const found = new Map<string, Found>();

  async function walk(dir: string, depth: number) {
    if (await exists(join(dir, "SKILL.md"))) {
      const skill = await skillAt(dir);
      if (!found.has(skill.name)) {
        found.set(skill.name, skill);
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
        found.set(name, await commandAt(join(commands, file)));
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function scanMachine(): Promise<Found[]> {
  const home = homedir();
  const found = new Map<string, Found>();
  for (const root of [join(home, ".claude", "skills"), join(home, ".agents", "skills")]) {
    for (const folder of await readdir(root).catch(() => [] as string[])) {
      const dir = join(root, folder);
      if (await exists(join(dir, "SKILL.md"))) {
        const skill = await skillAt(dir);
        if (!found.has(skill.name)) {
          found.set(skill.name, skill);
        }
      }
    }
  }
  // ss-* phase entry points are slash commands, not skill folders.
  const commands = join(home, ".claude", "commands");
  for (const file of await readdir(commands).catch(() => [] as string[])) {
    const name = file.replace(/\.md$/, "");
    if (file.endsWith(".md") && !found.has(name)) {
      found.set(name, await commandAt(join(commands, file)));
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// A ref names a skill by its frontmatter name or its folder; an exact name wins.
function findSkill(found: Found[], name: string) {
  return found.find((s) => s.name === name) ?? found.find((s) => s.folder === name);
}

export async function loadCatalog(sources: SkillSource[]) {
  const skills: CatalogSkill[] = (await scanMachine()).map((s) => ({
    name: s.name,
    folder: s.folder,
    description: s.description,
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
          ...found.map((s) => ({
            name: s.name,
            folder: s.folder,
            description: s.description,
            source: source.id,
            kind: s.kind,
          })),
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
// `path` is the skill folder, or the command file.
export type SkillContent =
  | { name: string; description: string; body: string; files: string[]; commit: string | null; path: string }
  | { error: string };

// Reads in place from the checkout or folder. A source that isn't connected, or is off, is never
// fetched or cloned.
export async function readSkill(ref: SkillRef, sources: SkillSource[]): Promise<SkillContent> {
  const [content] = await readSkills([ref], sources);
  return content ?? { error: `${ref.name}: not found in ${ref.source}.` };
}

// Like `readSkill` for many refs, in the same order, materialising and scanning each source once.
export async function readSkills(refs: SkillRef[], sources: SkillSource[]): Promise<SkillContent[]> {
  const scans = new Map<string, Promise<{ found: Found[]; commit: string | null }>>();
  function scanSource(id: string) {
    let pending = scans.get(id);
    if (!pending) {
      pending = scanFor(id, sources);
      scans.set(id, pending);
    }
    return pending;
  }
  return Promise.all(
    refs.map(async (ref): Promise<SkillContent> => {
      try {
        const { found, commit } = await scanSource(ref.source);
        const entry = findSkill(found, ref.name);
        if (!entry) {
          return { error: `${ref.name}: not found in ${ref.source}.` };
        }
        const file = entry.kind === "skill" ? join(entry.path, "SKILL.md") : entry.path;
        const { body } = readFrontmatter(await readFile(file, "utf8"));
        const files = entry.kind === "skill" ? (await listFiles(entry.path)).filter((f) => f !== file) : [];
        return { name: entry.name, description: entry.description, body, files, commit, path: entry.path };
      } catch (error) {
        return { error: `${ref.name}: ${message(error)}` };
      }
    }),
  );
}

async function scanFor(id: string, sources: SkillSource[]) {
  if (id === MACHINE_SOURCE) {
    return { found: await scanMachine(), commit: null };
  }
  const source = sources.find((s) => s.id === id);
  if (!source || !source.enabled) {
    throw new Error(`source "${id}" is not connected or is off.`);
  }
  return { found: await scan(await materialise(source)), commit: source.pin };
}

// Every file under a skill folder. Symlinks are followed only when they resolve inside the
// folder, and each real folder is read once, so a link out of the checkout or a link loop is skipped.
async function listFiles(root: string): Promise<string[]> {
  const top = await realpath(root);
  const inside = (real: string) => real === top || real.startsWith(top + sep);
  const seen = new Set<string>([top]);
  const files: string[] = [];

  async function walk(dir: string) {
    const entries = (await readdir(dir, { withFileTypes: true })).filter(
      (e) => e.name !== ".git" && e.name !== "node_modules",
    );
    const links: string[] = [];
    // Real folders first, so a folder reached through a link is listed under its own path.
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        links.push(path);
      } else if (entry.isDirectory()) {
        seen.add(await realpath(path));
        await walk(path);
      } else {
        files.push(path);
      }
    }
    for (const path of links) {
      const real = await realpath(path).catch(() => null);
      if (!real || !inside(real)) {
        continue;
      }
      if (!(await isDirectory(real))) {
        files.push(path);
      } else if (!seen.has(real)) {
        seen.add(real);
        await walk(path);
      }
    }
  }

  await walk(root);
  return files.sort();
}

// Copy the phase's skills from connected sources into the story worktree, where the agent
// picks them up as project skills. Machine skills are already global and are skipped.
export async function installSkills(cwd: string, refs: SkillRef[], sources: SkillSource[]) {
  const warnings: string[] = [];
  const excludes: string[] = [];
  // Which skill took each copy target in this phase, so a second skill with the same folder
  // name is skipped instead of overwriting the first. The same skill listed twice is just copied once.
  const claimed = new Map<string, { label: string; path: string }>();
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
      entry = findSkill(await scan(await materialise(source)), ref.name);
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
        ? [".claude/skills", ".cursor/skills", ".agents/skills"].map((d) => `${d}/${entry.folder}`)
        : [".claude/commands", ".cursor/commands"].map((d) => `${d}/${entry.folder}.md`);
    const key = `${entry.kind}:${entry.folder}`;
    const first = claimed.get(key);
    if (first?.path === entry.path) {
      continue;
    }
    if (first) {
      warnings.push(
        `${ref.name} (${source.label}): ${targets[0]} is already taken by ${first.label} in this phase; skipped.`,
      );
      continue;
    }
    claimed.set(key, { label: `${ref.name} (${source.label})`, path: entry.path });
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
