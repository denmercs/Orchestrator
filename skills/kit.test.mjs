import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Forbidden strings are built from pieces so this file never contains them.
export const NEEDLES = [
  { text: ["skill", "sync"].join(""), ignoreCase: true },
  { text: ["/ss", "-"].join(""), ignoreCase: false },
  { text: ["Lifeway", "IT"].join(""), ignoreCase: true },
  { text: ["DCD", "-"].join(""), ignoreCase: false },
  { text: ["Den", "Mercs"].join(""), ignoreCase: true },
  { text: ["/Us", "ers/"].join(""), ignoreCase: false },
];

export const ALLOWLIST = [];

function listFiles(root) {
  const files = [];
  for (const top of ["skills", "rules"]) {
    const dir = join(root, top);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      const full = join(entry.parentPath, entry.name);
      // Follow symlinked files too, so a linked file cannot slip past the scan.
      if (entry.isFile() || (entry.isSymbolicLink() && existsSync(full) && statSync(full).isFile())) files.push(full);
    }
  }
  return files;
}

function checkFrontmatter(file, text) {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const lines = block ? block[1].split(/\r?\n/) : [];
  const findings = [];
  for (const key of ["name", "description"]) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}:`));
    const value = idx === -1 ? "" : lines[idx].slice(key.length + 1).trim();
    const hasBody = /^[>|][+-]?$/.test(value) ? /^\s+\S/.test(lines[idx + 1] ?? "") : value !== "";
    if (!hasBody) findings.push({ file, line: 1, rule: "frontmatter", message: `SKILL.md frontmatter needs ${key}` });
  }
  return findings;
}

// A scripts/<file> hit written .claude/skills/<name>/scripts/<file> (or the ~/ form) names
// another skill; it resolves against any kit folder skills/*/<name>/ under the scanned root.
function prefixedSkill(before) {
  return before.match(/\.claude\/skills\/([\w-]+)\/$/)?.[1];
}

function kitHolds(root, name, path) {
  const skills = join(root, "skills");
  if (!existsSync(skills)) return false;
  return readdirSync(skills, { withFileTypes: true }).some((phase) => {
    if (!phase.isDirectory()) return false;
    const skillDir = join(skills, phase.name, name);
    const target = resolve(skillDir, path);
    return target.startsWith(skillDir + sep) && existsSync(target);
  });
}

function checkScripts(full, file, text, root) {
  const skillDir = dirname(full);
  const findings = [];
  text.split("\n").forEach((lineText, i) => {
    for (const m of lineText.matchAll(/(?<![\w-])scripts\/[\w./-]+/g)) {
      const path = m[0].replace(/[.,]+$/, "");
      const other = prefixedSkill(lineText.slice(0, m.index));
      if (other && other !== basename(skillDir)) {
        if (!kitHolds(root, other, path)) {
          findings.push({ file, line: i + 1, rule: "script-path", message: `${path} is not a file in kit skill ${other}` });
        }
        continue;
      }
      const target = resolve(skillDir, path);
      const inside = target.startsWith(skillDir + sep);
      if (!inside || !existsSync(target)) {
        findings.push({ file, line: i + 1, rule: "script-path", message: `${path} is not a file inside this skill` });
      }
    }
  });
  return findings;
}

export function scanKit(root, { allow = [] } = {}) {
  const findings = [];
  for (const full of listFiles(root)) {
    const file = relative(root, full).split("\\").join("/");
    const text = readFileSync(full, "utf8");
    if (text.includes("\0")) continue;
    if (basename(full) === "SKILL.md") {
      findings.push(...checkFrontmatter(file, text), ...checkScripts(full, file, text, root));
    }
    text.split("\n").forEach((lineText, i) => {
      for (const { text: needle, ignoreCase } of NEEDLES) {
        const hit = ignoreCase ? lineText.toLowerCase().includes(needle.toLowerCase()) : lineText.includes(needle);
        if (hit) {
          findings.push({ file, line: i + 1, rule: "forbidden-string", message: `contains ${JSON.stringify(needle)}`, needle });
        }
      }
    });
  }
  const allowed = (f) => allow.some((a) => a.file === f.file && a.needle === f.needle);
  return findings.filter((f) => !allowed(f)).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function tempRoot(files) {
  const root = mkdtempSync(join(tmpdir(), "kit-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

function withRoot(files, fn) {
  const root = tempRoot(files);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const FULL = "---\nname: demo\ndescription: A demo skill\n---\n\n# Demo\n";

test("missing skills/ and rules/ give no findings", () => {
  withRoot({}, (root) => assert.deepEqual(scanKit(root), []));
});

test("a clean skill gives no findings", () => {
  withRoot({ "skills/demo/SKILL.md": FULL }, (root) => assert.deepEqual(scanKit(root), []));
});

for (const { text } of NEEDLES) {
  for (const [file, dir] of [
    ["skills/demo/notes.md", "skills"],
    ["rules/style.md", "rules"],
  ]) {
    test(`flags ${JSON.stringify(text)} in ${dir}/ with file and line`, () => {
      withRoot({ "skills/demo/SKILL.md": FULL, [file]: `fine\nline two ${text} here\n` }, (root) => {
        const found = scanKit(root).filter((f) => f.rule === "forbidden-string");
        assert.equal(found.length, 1);
        assert.equal(found[0].file, file);
        assert.equal(found[0].line, 2);
      });
    });
  }
}

test("case-insensitive needles match other casing; exact-case ones do not", () => {
  withRoot({ "rules/a.md": `${["Skill", "Sync"].join("")}\n${["/SS", "-"].join("")}\n` }, (root) => {
    const lines = scanKit(root).map((f) => f.line);
    assert.deepEqual(lines, [1]);
  });
});

test("SKILL.md missing description fails", () => {
  withRoot({ "skills/demo/SKILL.md": "---\nname: demo\n---\nbody\n" }, (root) => {
    const found = scanKit(root);
    assert.equal(found.length, 1);
    assert.equal(found[0].rule, "frontmatter");
    assert.equal(found[0].file, "skills/demo/SKILL.md");
    assert.match(found[0].message, /description/);
  });
});

test("SKILL.md missing name fails", () => {
  withRoot({ "skills/demo/SKILL.md": "---\ndescription: x\n---\nbody\n" }, (root) => {
    const found = scanKit(root);
    assert.equal(found.length, 1);
    assert.match(found[0].message, /name/);
  });
});

test("SKILL.md with no frontmatter fails; block-scalar description passes", () => {
  withRoot({ "skills/a/SKILL.md": "# no frontmatter\n" }, (root) => {
    assert.equal(scanKit(root).length, 2);
  });
  withRoot({ "skills/a/SKILL.md": "---\nname: a\ndescription: >\n  folded text\n---\n" }, (root) => {
    assert.deepEqual(scanKit(root), []);
  });
});

test("a block-scalar key with no indented text fails", () => {
  withRoot({ "skills/a/SKILL.md": "---\ndescription: >\nname: a\n---\n" }, (root) => {
    const found = scanKit(root);
    assert.equal(found.length, 1);
    assert.match(found[0].message, /description/);
  });
});

test("SKILL.md naming a missing script fails", () => {
  withRoot({ "skills/demo/SKILL.md": `${FULL}Run scripts/missing.mjs now.\n` }, (root) => {
    const found = scanKit(root);
    assert.equal(found.length, 1);
    assert.equal(found[0].rule, "script-path");
    assert.equal(found[0].file, "skills/demo/SKILL.md");
    assert.equal(found[0].line, 7);
  });
});

test("SKILL.md naming an existing script passes", () => {
  withRoot({ "skills/demo/SKILL.md": `${FULL}Run \`scripts/run.mjs\`.\n`, "skills/demo/scripts/run.mjs": "" }, (root) => {
    assert.deepEqual(scanKit(root), []);
  });
});

test("scripts/ inside a longer word is not a script path", () => {
  withRoot({ "skills/demo/SKILL.md": `${FULL}See myscripts/missing.mjs and pre-scripts/x.mjs\n` }, (root) => {
    assert.deepEqual(scanKit(root), []);
  });
});

test("a missing script is reported without trailing punctuation", () => {
  withRoot({ "skills/demo/SKILL.md": `${FULL}Run scripts/missing.mjs.\n` }, (root) => {
    assert.equal(scanKit(root)[0].message, "scripts/missing.mjs is not a file inside this skill");
  });
});

test("a symlinked file under skills/ is scanned", () => {
  withRoot({ "outside.md": `${NEEDLES[0].text}\n`, "skills/demo/SKILL.md": FULL }, (root) => {
    symlinkSync(join(root, "outside.md"), join(root, "skills/demo/linked.md"));
    assert.deepEqual(scanKit(root).map((f) => f.file), ["skills/demo/linked.md"]);
  });
});

test("a script path that escapes the skill folder fails", () => {
  withRoot({ "skills/demo/SKILL.md": `${FULL}See scripts/../../x\n`, "skills/x": "" }, (root) => {
    assert.equal(scanKit(root).filter((f) => f.rule === "script-path").length, 1);
  });
});

test("ALLOWLIST is empty", () => {
  assert.deepEqual(ALLOWLIST, []);
});

test("an allow entry suppresses its finding only", () => {
  const needle = NEEDLES[0].text;
  withRoot({ "rules/a.md": `${needle}\n`, "rules/b.md": `${needle}\n` }, (root) => {
    const found = scanKit(root, { allow: [{ file: "rules/a.md", needle }] });
    assert.deepEqual(found.map((f) => f.file), ["rules/b.md"]);
  });
});

test("the real repo kit passes the guard", () => {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const found = scanKit(repoRoot, { allow: ALLOWLIST });
  assert.deepEqual(
    found.map((f) => `${f.file}:${f.line} ${f.rule} ${f.message}`),
    [],
  );
});

export const PLAN_SKILLS = ["anti-slop", "arch-plan", "jira-write-ticket", "major-feature-roadmap", "plan-html", "ui-ux-planner"];

// [phase, name] of each skill that renders a living plan through plan-html.
export const LIVING_PLAN_SKILLS = [
  ["plan", "arch-plan"],
  ["plan", "ui-ux-planner"],
  ["review", "code-handoff"],
];

test("living plan skills name plan-html and its render script", () => {
  for (const [phase, name] of LIVING_PLAN_SKILLS) {
    const text = readFileSync(join(REPO_ROOT, "skills", phase, name, "SKILL.md"), "utf8");
    const section = text.match(/^## Companion extra\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? "";
    assert.ok(section.includes("plan-html"), `${name} needs a Companion extra section naming plan-html`);
    assert.ok(text.includes(".claude/skills/plan-html/scripts/render-plan-html.cjs"), `${name} must name render-plan-html.cjs`);
    assert.ok(!text.includes(".cursor/vendor"), `${name} must not mention .cursor/vendor`);
    assert.ok(!text.includes("refresh-plan-status"), `${name} must not mention refresh-plan-status`);
  }
});

test("no app-map or wayfinder skill folder exists", () => {
  const skillsDir = join(REPO_ROOT, "skills");
  for (const phase of readdirSync(skillsDir)) {
    if (!statSync(join(skillsDir, phase)).isDirectory()) continue;
    for (const name of ["app-map", "wayfinder"]) {
      assert.ok(!existsSync(join(skillsDir, phase, name)), `skills/${phase}/${name} must not exist`);
    }
  }
});

export const IMPLEMENT_SKILLS = ["bugfix", "feature-video-evidence", "visual-parity-check"];

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function checkNamedAfterFolder(phase, names) {
  for (const name of names) {
    const file = join(REPO_ROOT, "skills", phase, name, "SKILL.md");
    assert.ok(existsSync(file), `skills/${phase}/${name}/SKILL.md is missing`);
    const frontmatter = readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    const declared = frontmatter.match(/^name:\s*(\S+)\s*$/m)?.[1];
    assert.equal(declared, name);
  }
}

test("plan skills exist and are named after their folder", () => {
  checkNamedAfterFolder("plan", PLAN_SKILLS);
});

test("implement skills exist and are named after their folder", () => {
  checkNamedAfterFolder("implement", IMPLEMENT_SKILLS);
});

test("visual-parity-check holds no private values", () => {
  const root = join(REPO_ROOT, "skills", "implement", "visual-parity-check");
  const patterns = [
    [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, "a UUID-shaped id"],
    [/[0-9a-f]{8}-[0-9a-f]{16}/i, "a UDID-shaped id"],
    [new RegExp(["life", "way"].join(""), "i"), "the org name"],
    [new RegExp(["DCD", ""].join("-")), "a ticket key"],
  ];
  const files = listFiles(REPO_ROOT).filter((full) => full.startsWith(root + sep));
  assert.ok(files.length > 0, "the scan found no files");
  const hits = [];
  for (const full of files) {
    const text = readFileSync(full, "utf8");
    for (const [re, label] of patterns) if (re.test(text)) hits.push(`${relative(REPO_ROOT, full)} contains ${label}`);
  }
  assert.deepEqual(hits, []);
  const skill = readFileSync(join(root, "SKILL.md"), "utf8");
  assert.match(skill, /## Private values/);
  assert.match(skill, /private file outside the repo/);
});

export const REVIEW_SKILLS = ["code-handoff", "peer-review", "review-patterns"];

test("review skills exist and are named after their folder", () => {
  checkNamedAfterFolder("review", REVIEW_SKILLS);
});

export const DONE_SKILLS = ["submit-github-pr", "jira-close-story"];

test("done skills exist and are named after their folder", () => {
  checkNamedAfterFolder("done", DONE_SKILLS);
});

test("done skills do not depend on harness files", () => {
  const needles = [".harness/", ["harness", "reset"].join("-")];
  const hits = [];
  for (const full of listFiles(REPO_ROOT)) {
    const rel = relative(REPO_ROOT, full).split("\\").join("/");
    if (!rel.startsWith("skills/done/")) continue;
    const text = readFileSync(full, "utf8");
    for (const needle of needles) if (text.includes(needle)) hits.push(`${rel} contains ${needle}`);
  }
  assert.deepEqual(hits, []);
});

// Each copied script, run with --help, must exit 0 and not fail on a missing module.
export const SCRIPT_HELP = [
  ["implement", "bugfix", "bugfix-debug-log.cjs"],
  ["implement", "feature-video-evidence", "collect-video.cjs"],
  ["review", "peer-review", "list-prs.cjs"],
  ["review", "review-patterns", "mine-review-patterns.cjs"],
];

for (const [phase, name, file] of SCRIPT_HELP) {
  test(`${name}/scripts/${file} --help exits 0 with no missing module`, () => {
    const script = join(REPO_ROOT, "skills", phase, name, "scripts", file);
    const result = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8", timeout: 10000 });
    assert.doesNotMatch(result.stderr, /Cannot find module/);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /[Uu]sage/);
  });
}

test("bugfix --self-test prints self-test OK", () => {
  const script = join(REPO_ROOT, "skills", "implement", "bugfix", "scripts", "bugfix-debug-log.cjs");
  const result = spawnSync(process.execPath, [script, "--self-test"], { encoding: "utf8", timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /self-test OK/);
});

const BUGFIX_SCRIPT = join(REPO_ROOT, "skills", "implement", "bugfix", "scripts", "bugfix-debug-log.cjs");

test("bugfix --self-test passes while its old fixed port is taken", async () => {
  const blocker = createServer();
  await new Promise((done) => blocker.listen(17432, "127.0.0.1", done));
  try {
    const result = await new Promise((done) => {
      const child = spawn(process.execPath, [BUGFIX_SCRIPT, "--self-test"], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b) => (stdout += b));
      child.stderr.on("data", (b) => (stderr += b));
      child.on("exit", (status) => done({ status, stdout, stderr }));
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /self-test OK/);
  } finally {
    blocker.close();
  }
});

test("bugfix ingest health check does not reveal the log path", async () => {
  const root = mkdtempSync(join(tmpdir(), "bugfix-health-"));
  const child = spawn(process.execPath, [BUGFIX_SCRIPT, "start", "--tag", "b5e3", "--port", "0", root], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const url = await new Promise((done, fail) => {
      child.stdout.on("data", (b) => {
        const m = String(b).match(/url=(\S+)/);
        if (m) done(m[1]);
      });
      child.on("exit", (code) => fail(new Error(`ingest exited ${code}`)));
    });
    const body = await (await fetch(url)).json();
    assert.equal(body.ok, true);
    assert.ok(!JSON.stringify(body).includes(root), JSON.stringify(body));
  } finally {
    child.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
});

// Every scripts/<file> in a SKILL.md must be written .claude/skills/<folder>/scripts/<file>,
// and the file must also name the ~/.claude/skills/<folder>/scripts/<file> fallback.
export function checkScriptForm(root) {
  const findings = [];
  for (const full of listFiles(root)) {
    if (basename(full) !== "SKILL.md") continue;
    const file = relative(root, full).split("\\").join("/");
    const folder = basename(dirname(full));
    const text = readFileSync(full, "utf8");
    const used = new Set();
    const usedOther = new Set();
    text.split("\n").forEach((lineText, i) => {
      for (const m of lineText.matchAll(/(?<![\w-])scripts\/([\w./-]+)/g)) {
        const scriptFile = m[1].replace(/[.,]+$/, "");
        const before = lineText.slice(0, m.index);
        const other = prefixedSkill(before);
        if (other && other !== folder) {
          usedOther.add(`${other}/scripts/${scriptFile}`);
          continue;
        }
        used.add(scriptFile);
        if (!before.endsWith(`.claude/skills/${folder}/`)) {
          findings.push({ file, line: i + 1, message: `scripts/${scriptFile} must be written .claude/skills/${folder}/scripts/${scriptFile}` });
        }
      }
    });
    for (const path of usedOther) {
      if (!text.includes(`~/.claude/skills/${path}`)) {
        findings.push({ file, line: 1, message: `missing fallback ~/.claude/skills/${path}` });
      }
    }
    for (const scriptFile of used) {
      if (!text.includes(`~/.claude/skills/${folder}/scripts/${scriptFile}`)) {
        findings.push({ file, line: 1, message: `missing fallback ~/.claude/skills/${folder}/scripts/${scriptFile}` });
      }
    }
  }
  return findings;
}

test("a bare scripts/ path fails the script-form check", () => {
  withRoot({ "skills/demo/SKILL.md": `${FULL}Run scripts/run.mjs.\n`, "skills/demo/scripts/run.mjs": "" }, (root) => {
    const found = checkScriptForm(root);
    assert.equal(found.length, 2);
    assert.equal(found[0].line, 7);
  });
});

test("a project path without the home fallback fails the script-form check", () => {
  withRoot({ "skills/demo/SKILL.md": `${FULL}Run .claude/skills/demo/scripts/run.mjs.\n`, "skills/demo/scripts/run.mjs": "" }, (root) => {
    const found = checkScriptForm(root);
    assert.equal(found.length, 1);
    assert.match(found[0].message, /fallback/);
  });
});

test("both script path forms pass the script-form check", () => {
  const body = `${FULL}Run .claude/skills/demo/scripts/run.mjs (fallback ~/.claude/skills/demo/scripts/run.mjs).\n`;
  withRoot({ "skills/demo/SKILL.md": body, "skills/demo/scripts/run.mjs": "" }, (root) => {
    assert.deepEqual(checkScriptForm(root), []);
  });
});

test("the real repo kit writes script paths in both forms", () => {
  assert.deepEqual(
    checkScriptForm(REPO_ROOT).map((f) => `${f.file}:${f.line} ${f.message}`),
    [],
  );
});

const CROSS_BODY = `${FULL}Run .claude/skills/y/scripts/run.cjs (fallback ~/.claude/skills/y/scripts/run.cjs).\n`;

test("a cross-skill script path passes when another kit skill holds the file", () => {
  withRoot({ "skills/a/x/SKILL.md": CROSS_BODY, "skills/b/y/scripts/run.cjs": "" }, (root) => {
    assert.deepEqual(scanKit(root).filter((f) => f.rule === "script-path"), []);
    assert.deepEqual(checkScriptForm(root), []);
  });
});

test("a cross-skill script path fails script-path when the file is missing", () => {
  withRoot({ "skills/a/x/SKILL.md": CROSS_BODY, "skills/b/y/SKILL.md": FULL.replace("demo", "y") }, (root) => {
    const found = scanKit(root).filter((f) => f.rule === "script-path");
    assert.equal(found.length, 2);
    assert.deepEqual(found.map((f) => f.line), [7, 7]);
  });
});

test("plan-html renders and validates from a temp copy under .claude/skills", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plan-html-"));
  try {
    const dest = join(tmp, ".claude", "skills", "plan-html");
    cpSync(join(REPO_ROOT, "skills", "plan", "plan-html"), dest, { recursive: true });
    cpSync(join(dest, "scripts", "fixtures", "plan-arch-valid.md"), join(tmp, "plan.md"));
    const run = spawnSync(
      process.execPath,
      [join(dest, "scripts", "render-plan-html.cjs"), tmp, "--kind", "arch", "--file", "plan.md", "--out", "plan.html", "--validate"],
      { cwd: tmp, encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.ok(!run.stderr.includes("Cannot find module"), run.stderr);
    assert.ok(existsSync(join(tmp, "plan.html")));
    assert.ok(readFileSync(join(tmp, "plan.html"), "utf8").includes('id="current"'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("plan-html init scaffolds the Markdown and HTML from a temp copy", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plan-html-init-"));
  try {
    const dest = join(tmp, ".claude", "skills", "plan-html");
    cpSync(join(REPO_ROOT, "skills", "plan", "plan-html"), dest, { recursive: true });
    const run = spawnSync(
      process.execPath,
      [join(dest, "scripts", "init-plan-html.cjs"), tmp, "--kind", "arch", "--slug", "demo"],
      { cwd: tmp, encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    const pack = join(tmp, ".harness", "initiatives", "demo");
    assert.ok(existsSync(join(pack, "architecture-plan.md")));
    assert.ok(existsSync(join(pack, "architecture-plan.html")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("plan-html init rejects a slug that leaves the initiatives folder", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plan-html-slug-"));
  try {
    const dest = join(tmp, ".claude", "skills", "plan-html");
    cpSync(join(REPO_ROOT, "skills", "plan", "plan-html"), dest, { recursive: true });
    const run = spawnSync(
      process.execPath,
      [join(dest, "scripts", "init-plan-html.cjs"), tmp, "--kind", "ux", "--slug", "../../escape"],
      { cwd: tmp, encoding: "utf8" },
    );
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Invalid --slug/);
    assert.ok(!existsSync(join(tmp, "escape")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Skills written in this repo. Each pair is [phase, name].
export const OWN_SKILLS = [
  ["plan", "grill-me"],
  ["plan", "grill-tdd"],
  ["implement", "tdd"],
  ["plan", "prototype"],
];

const OWN_SKILL_BANNED = ["pocock", "mattpocock", "github.com/", ".harness/", "harness-reset", "tdd-audit", "re-break"];

function readOwnSkill([phase, name]) {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const file = join(repoRoot, "skills", phase, name, "SKILL.md");
  assert.ok(existsSync(file), `skills/${phase}/${name}/SKILL.md is missing`);
  return readFileSync(file, "utf8");
}

test("own skills are named after their folder and carry no upstream or tool references", () => {
  for (const pair of OWN_SKILLS) {
    const text = readOwnSkill(pair);
    const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    assert.equal(frontmatter.match(/^name:\s*(\S+)\s*$/m)?.[1], pair[1]);
    const lower = text.toLowerCase();
    for (const banned of OWN_SKILL_BANNED) {
      assert.ok(!lower.includes(banned), `skills/${pair[0]}/${pair[1]} mentions ${banned}`);
    }
  }
});

test("grill-tdd follows grill-me and hands off to tdd", () => {
  const text = readOwnSkill(["plan", "grill-tdd"]);
  assert.match(text, /grill-me/);
  assert.match(text, /(?<![\w-])tdd\b/);
});

test("tdd says contract grilling is grill-tdd", () => {
  assert.match(readOwnSkill(["implement", "tdd"]), /grill-tdd/);
});

test("peer-review has an own-branch mode that skips Phases 1 and 5 and maps severities to the loop checklist", () => {
  const text = readOwnSkill(["review", "peer-review"]);
  const section = text.match(/^## Own branch\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1];
  assert.ok(section, "peer-review has no ## Own branch section");
  assert.match(section, /Phases? 2[–-]4/);
  assert.match(section, /skip Phases? 1 and 5/i);
  assert.match(section, /rules 1[–-]4[^\n]*do not apply/i);
  assert.match(section, /no-write/i);
  assert.match(section, /no-post/i);
  assert.match(section, /blocking[^\n]*`blocking:`/);
  assert.match(section, /should-fix[^\n]*`non-blocking:`/);
  assert.match(section, /question[^\n]*`non-blocking:`/);
  assert.match(section, /nit[^\n]*`non-blocking:`[^\n]*at most 3/);
  assert.match(section, /step prompt wins/i);
});

// list-prs.cjs runs against a stub gh first on PATH; no network.
function withStubGh({ exitCode = 0, json = "[]" }, fn) {
  const dir = mkdtempSync(join(tmpdir(), "stub-gh-"));
  try {
    writeFileSync(join(dir, "fixture.json"), json);
    writeFileSync(
      join(dir, "gh"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, "argv.txt")}"\nif [ ${exitCode} -ne 0 ]; then echo "gh: boom" >&2; exit ${exitCode}; fi\ncat "${join(dir, "fixture.json")}"\n`,
      { mode: 0o755 },
    );
    const script = join(REPO_ROOT, "skills", "review", "peer-review", "scripts", "list-prs.cjs");
    const run = (...args) =>
      spawnSync(process.execPath, [script, ...args], {
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      });
    const argv = () => readFileSync(join(dir, "argv.txt"), "utf8").trim().split("\n");
    return fn({ run, argv });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PR_FIXTURE = JSON.stringify([
  {
    number: 12,
    title: "Fix login",
    url: "https://github.com/acme/web/pull/12",
    repository: { nameWithOwner: "acme/web" },
    author: { login: "alice" },
    updatedAt: "2026-10-01T00:00:00Z",
    isDraft: false,
  },
]);

test("list-prs prints one PR as a line plus its URL", () => {
  withStubGh({ json: PR_FIXTURE }, ({ run }) => {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "acme/web#12 · alice · Fix login\nhttps://github.com/acme/web/pull/12\n");
  });
});

test("list-prs --json prints the parsed array", () => {
  withStubGh({ json: PR_FIXTURE }, ({ run }) => {
    const r = run("--json");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).map((p) => p.number), [12]);
  });
});

test("list-prs asks gh for search prs and passes --repo through", () => {
  withStubGh({ json: PR_FIXTURE }, ({ run, argv }) => {
    run("--repo", "acme/web");
    const args = argv();
    assert.deepEqual(args.slice(0, 2), ["search", "prs"]);
    assert.ok(args.includes("--review-requested=@me"));
    assert.equal(args[args.indexOf("--repo") + 1], "acme/web");
  });
});

test("list-prs exits 1 with a message on stderr when gh fails", () => {
  withStubGh({ exitCode: 1 }, ({ run }) => {
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /gh/);
  });
});

test("peer-review ships a generic profile file and a rubric without mined team patterns", () => {
  const dir = join(REPO_ROOT, "skills", "review", "peer-review");
  assert.ok(!readFileSync(join(dir, "PROFILES.md"), "utf8").includes(["Life", "way"].join("")));
  assert.ok(!readFileSync(join(dir, "REVIEW-RUBRIC.md"), "utf8").includes("## Team review patterns"));
});

test("list-prs says so when no PR is waiting", () => {
  withStubGh({ json: "[]" }, ({ run }) => {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /No open PRs are waiting on your review/);
  });
});

test("list-prs names the flag that is missing its value", () => {
  withStubGh({ json: "[]" }, ({ run }) => {
    const r = run("--repo");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--repo needs a value/);
  });
});
