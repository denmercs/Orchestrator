import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

function checkScripts(full, file, text) {
  const skillDir = dirname(full);
  const findings = [];
  text.split("\n").forEach((lineText, i) => {
    for (const [match] of lineText.matchAll(/(?<![\w-])scripts\/[\w./-]+/g)) {
      const path = match.replace(/[.,]+$/, "");
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
      findings.push(...checkFrontmatter(file, text), ...checkScripts(full, file, text));
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

export const PLAN_SKILLS = ["anti-slop", "jira-write-ticket", "major-feature-roadmap"];

export const IMPLEMENT_SKILLS = ["bugfix", "feature-video-evidence"];

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
    text.split("\n").forEach((lineText, i) => {
      for (const m of lineText.matchAll(/(?<![\w-])scripts\/([\w./-]+)/g)) {
        const scriptFile = m[1].replace(/[.,]+$/, "");
        used.add(scriptFile);
        const before = lineText.slice(0, m.index);
        if (!before.endsWith(`.claude/skills/${folder}/`)) {
          findings.push({ file, line: i + 1, message: `scripts/${scriptFile} must be written .claude/skills/${folder}/scripts/${scriptFile}` });
        }
      }
    });
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
