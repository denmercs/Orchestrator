// Links the kit's skills into a home folder:
//   node scripts/link-kit.mjs [--home D] [--kit D] [--dry-run]
//
// This file names `skillsync` on purpose (later passes use it to recognise stale links left by the old
// repo). It sits in scripts/, outside the guard test's scan: skills/kit.test.mjs scans only skills/ and rules/.
//
// Three passes: gather (args, skills), validate (before any write), apply (link and report).
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function parseArgs(argv) {
  const opts = { home: homedir(), kit: fileURLToPath(new URL("..", import.meta.url)), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (argv[i] !== "--home" && argv[i] !== "--kit") continue;
    if (!value || value.startsWith("--")) throw new Error(`${argv[i]} needs a folder`);
    opts[argv[i].slice(2)] = value;
    i++;
  }
  return { ...opts, home: resolve(opts.home), kit: resolve(opts.kit) };
}

function isDir(path) {
  return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

// Every <kit>/skills/<phase>/<name>/ that holds a SKILL.md.
function findSkills(kit) {
  const skills = [];
  const root = join(kit, "skills");
  if (!isDir(root)) return skills;
  for (const phase of readdirSync(root).sort()) {
    if (!isDir(join(root, phase))) continue;
    for (const name of readdirSync(join(root, phase)).sort()) {
      const dir = join(root, phase, name);
      if (isDir(dir) && existsSync(join(dir, "SKILL.md"))) skills.push({ name, dir });
    }
  }
  return skills;
}

// Rule names from lines `- @~/.claude/rules/<name>.mdc` (same pattern as skillsync's link-global-rules).
// Returns null when the kit has no rules/index.md.
function findRules(kit) {
  const index = join(kit, "rules", "index.md");
  if (!existsSync(index)) return null;
  const names = [...readFileSync(index, "utf8").matchAll(/^- @~\/\.claude\/rules\/([\w.-]+\.mdc)\s*$/gm)].map((m) => m[1]);
  return { index, names };
}

function gather(argv) {
  const opts = parseArgs(argv);
  return { ...opts, skills: findSkills(opts.kit), rules: findRules(opts.kit) };
}

// Checks run before any write. Later cycles add more (missing rules).
function validate(plan) {
  const seen = new Map();
  for (const { name, dir } of plan.skills) {
    if (seen.has(name)) throw new Error(`duplicate skill name "${name}": ${seen.get(name)} and ${dir}`);
    seen.set(name, dir);
  }
  for (const name of plan.rules?.names ?? []) {
    if (!existsSync(join(plan.kit, "rules", name))) throw new Error(`rule "${name}" is listed in rules/index.md but missing from ${join(plan.kit, "rules")}`);
  }
  return plan;
}

// A link is ours when its target (resolved even if dangling) is inside the kit or under a `skillsync` folder.
function isOurs(link, kit) {
  const target = resolve(dirname(link), readlinkSync(link));
  const inKit = !relative(kit, target).startsWith("..") && relative(kit, target) !== "";
  return inKit || target.split(sep).includes("skillsync");
}

function skipReason(link) {
  return lstatSync(link).isSymbolicLink() ? "skipped foreign link" : "skipped real file";
}

// Makes `dir` hold exactly the wanted links (name -> target) among ours; real files and foreign links are skipped.
function syncDir(dir, wanted, plan, log) {
  if (wanted.size && !plan.dryRun) mkdirSync(dir, { recursive: true });
  for (const [name, target] of wanted) {
    const link = join(dir, name);
    const stat = lstatSync(link, { throwIfNoEntry: false });
    if (stat) {
      if (!stat.isSymbolicLink() || !isOurs(link, plan.kit)) {
        log(`${skipReason(link)} ${link}`);
        continue;
      }
      if (readlinkSync(link) === target) {
        log(`unchanged ${link}`);
        continue;
      }
      if (!plan.dryRun) unlinkSync(link);
    }
    if (!plan.dryRun) symlinkSync(target, link);
    log(`linked ${link} -> ${target}`);
  }
  if (!isDir(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    if (wanted.has(name)) continue;
    const link = join(dir, name);
    if (lstatSync(link).isSymbolicLink() && isOurs(link, plan.kit)) {
      if (!plan.dryRun) unlinkSync(link);
      log(`removed stale ${link}`);
    } else {
      log(`${skipReason(link)} ${link}`);
    }
  }
}

function apply(plan, log) {
  syncDir(join(plan.home, ".claude", "skills"), new Map(plan.skills.map(({ name, dir }) => [name, dir])), plan, log);
  if (!plan.rules) {
    log("no rules/index.md, rules skipped");
    return;
  }
  const rule = (name) => join(plan.kit, "rules", name);
  const claude = new Map([["index.md", plan.rules.index], ...plan.rules.names.map((name) => [name, rule(name)])]);
  const kiro = new Map(plan.rules.names.map((name) => [name.replace(/\.mdc$/, ".md"), rule(name)]));
  syncDir(join(plan.home, ".claude", "rules"), claude, plan, log);
  syncDir(join(plan.home, ".kiro", "steering"), kiro, plan, log);
}

export function run(argv, { log = console.log } = {}) {
  apply(validate(gather(argv)), log);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error("usage: link-kit.mjs [--home D] [--kit D] [--dry-run]");
    process.exitCode = 1;
  }
}
