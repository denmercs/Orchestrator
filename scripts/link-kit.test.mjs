import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "link-kit-"));
}

function withRoot(fn) {
  const root = tempRoot();
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function write(file, text = "") {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

function runLinkKit(home, kit, ...extra) {
  return spawnSync(process.execPath, ["scripts/link-kit.mjs", "--home", home, "--kit", kit, ...extra], { encoding: "utf8" });
}

test("links every skill folder holding SKILL.md into <home>/.claude/skills", () => {
  withRoot((root) => {
    const kit = join(root, "kit");
    const home = join(root, "home");
    mkdirSync(home);
    write(join(kit, "skills/plan/a/SKILL.md"), "a");
    write(join(kit, "skills/review/b/SKILL.md"), "b");
    mkdirSync(join(kit, "skills/plan/no-skill-md"), { recursive: true });
    write(join(kit, "skills/stray.txt"), "x");

    const result = runLinkKit(home, kit);
    assert.equal(result.status, 0, result.stderr);

    const skills = join(home, ".claude/skills");
    assert.deepEqual(readdirSync(skills).sort(), ["a", "b"]);
    for (const [name, phase] of [["a", "plan"], ["b", "review"]]) {
      const link = join(skills, name);
      assert.ok(lstatSync(link).isSymbolicLink());
      assert.equal(readlinkSync(link), join(kit, "skills", phase, name));
    }
    assert.deepEqual(readdirSync(join(home, ".claude")), ["skills"]);
    assert.match(result.stdout, new RegExp(`linked ${join(skills, "a")} -> ${join(kit, "skills/plan/a")}`));
  });
});

test("a second run changes nothing and reports only unchanged lines", () => {
  withRoot((root) => {
    const kit = join(root, "kit");
    const home = join(root, "home");
    mkdirSync(home);
    write(join(kit, "skills/plan/a/SKILL.md"), "a");
    write(join(kit, "skills/review/b/SKILL.md"), "b");

    assert.equal(runLinkKit(home, kit).status, 0);
    const skills = join(home, ".claude/skills");
    const before = readdirSync(skills).map((name) => [name, readlinkSync(join(skills, name))]);

    const second = runLinkKit(home, kit);
    assert.equal(second.status, 0, second.stderr);
    const after = readdirSync(skills).map((name) => [name, readlinkSync(join(skills, name))]);
    assert.deepEqual(after, before);

    const lines = second.stdout.trim().split("\n").filter((line) => !line.startsWith("no rules/index.md"));
    assert.equal(lines.length, 2);
    for (const line of lines) assert.match(line, /^unchanged /);
    assert.ok(!lines.some((line) => line.startsWith("linked ")));
  });
});

test("prunes stale links, repoints skillsync links, and skips real and foreign things", () => {
  withRoot((root) => {
    const kit = join(root, "kit");
    const home = join(root, "home");
    const skills = join(home, ".claude/skills");
    const commands = join(home, ".claude/commands");
    for (const name of ["a", "b", "c", "d"]) write(join(kit, "skills/plan", name, "SKILL.md"), name);
    mkdirSync(skills, { recursive: true });
    const oldSkillsync = join(root, "elsewhere/skillsync/skills/x/old");
    const staleKit = join(kit, "skills/plan/removed");
    const foreign = join(root, "other/foreign");
    symlinkSync(oldSkillsync, join(skills, "old"));
    symlinkSync(staleKit, join(skills, "gone"));
    symlinkSync(join(root, "elsewhere/skillsync/skills/plan/a"), join(skills, "a"));
    mkdirSync(join(skills, "b"));
    symlinkSync(foreign, join(skills, "c"));
    write(join(skills, "d"), "mine");
    write(join(skills, "notes.txt"), "mine");
    symlinkSync(foreign, join(skills, "foreign"));
    symlinkSync(join(root, "elsewhere/skillsync/commands"), commands);

    const result = runLinkKit(home, kit);
    assert.equal(result.status, 0, result.stderr);

    for (const name of ["old", "gone"]) assert.equal(lstatSync(join(skills, name), { throwIfNoEntry: false }), undefined);
    assert.equal(readlinkSync(join(skills, "a")), join(kit, "skills/plan/a"));
    assert.ok(lstatSync(join(skills, "b")).isDirectory());
    assert.equal(readlinkSync(join(skills, "c")), foreign);
    assert.equal(readFileSync(join(skills, "d"), "utf8"), "mine");
    assert.equal(readFileSync(join(skills, "notes.txt"), "utf8"), "mine");
    assert.equal(readlinkSync(join(skills, "foreign")), foreign);
    assert.equal(readlinkSync(commands), join(root, "elsewhere/skillsync/commands"));

    const out = result.stdout;
    assert.match(out, new RegExp(`removed stale ${join(skills, "old")}`));
    assert.match(out, new RegExp(`removed stale ${join(skills, "gone")}`));
    assert.match(out, new RegExp(`skipped real file ${join(skills, "b")}`));
    assert.match(out, new RegExp(`skipped real file ${join(skills, "d")}`));
    assert.match(out, new RegExp(`skipped foreign link ${join(skills, "c")}`));
    assert.match(out, new RegExp(`skipped foreign link ${join(skills, "foreign")}`));
    assert.ok(!out.includes(commands));
  });
});

test("a duplicate skill name exits 1 naming both folders and writes nothing", () => {
  withRoot((root) => {
    const kit = join(root, "kit");
    const home = join(root, "home");
    mkdirSync(home);
    write(join(kit, "skills/plan/dup/SKILL.md"), "p");
    write(join(kit, "skills/review/dup/SKILL.md"), "r");
    write(join(kit, "skills/plan/ok/SKILL.md"), "ok");

    const result = runLinkKit(home, kit);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(join(kit, "skills/plan/dup")), result.stderr);
    assert.ok(result.stderr.includes(join(kit, "skills/review/dup")), result.stderr);
    assert.deepEqual(readdirSync(home), []);
  });
});

function rulesKit(root, indexLines = ["- @~/.claude/rules/x.mdc", "- @~/.claude/rules/y.mdc"]) {
  const kit = join(root, "kit");
  write(join(kit, "rules/index.md"), `# Rules\n\n${indexLines.join("\n")}\n`);
  write(join(kit, "rules/x.mdc"), "x");
  write(join(kit, "rules/y.mdc"), "y");
  write(join(kit, "skills/plan/a/SKILL.md"), "a");
  return kit;
}

test("links rules into .claude/rules and .kiro/steering, and prunes stale rule links", () => {
  withRoot((root) => {
    const kit = rulesKit(root);
    const home = join(root, "home");
    const claude = join(home, ".claude/rules");
    const kiro = join(home, ".kiro/steering");
    mkdirSync(claude, { recursive: true });
    mkdirSync(kiro, { recursive: true });
    const foreign = join(root, "other/foreign");
    symlinkSync(join(root, "elsewhere/skillsync/rules/old.mdc"), join(claude, "old.mdc"));
    symlinkSync(join(root, "elsewhere/skillsync/rules/old.mdc"), join(kiro, "old.md"));
    symlinkSync(foreign, join(claude, "foreign.mdc"));
    symlinkSync(foreign, join(kiro, "foreign.md"));
    write(join(claude, "mine.mdc"), "mine");
    write(join(kiro, "mine.md"), "mine");

    const result = runLinkKit(home, kit);
    assert.equal(result.status, 0, result.stderr);

    for (const name of ["index.md", "x.mdc", "y.mdc"]) {
      assert.ok(lstatSync(join(claude, name)).isSymbolicLink());
      assert.equal(readlinkSync(join(claude, name)), join(kit, "rules", name));
    }
    for (const [name, source] of [["x.md", "x.mdc"], ["y.md", "y.mdc"]]) {
      assert.ok(lstatSync(join(kiro, name)).isSymbolicLink());
      assert.equal(readlinkSync(join(kiro, name)), join(kit, "rules", source));
    }
    assert.equal(lstatSync(join(kiro, "index.md"), { throwIfNoEntry: false }), undefined);
    assert.equal(lstatSync(join(claude, "old.mdc"), { throwIfNoEntry: false }), undefined);
    assert.equal(lstatSync(join(kiro, "old.md"), { throwIfNoEntry: false }), undefined);
    assert.equal(readlinkSync(join(claude, "foreign.mdc")), foreign);
    assert.equal(readlinkSync(join(kiro, "foreign.md")), foreign);
    assert.equal(readFileSync(join(claude, "mine.mdc"), "utf8"), "mine");
    assert.equal(readFileSync(join(kiro, "mine.md"), "utf8"), "mine");

    const out = result.stdout;
    assert.match(out, new RegExp(`removed stale ${join(claude, "old.mdc")}`));
    assert.match(out, new RegExp(`removed stale ${join(kiro, "old.md")}`));
    assert.match(out, new RegExp(`skipped foreign link ${join(claude, "foreign.mdc")}`));
    assert.match(out, new RegExp(`skipped foreign link ${join(kiro, "foreign.md")}`));
    assert.match(out, new RegExp(`skipped real file ${join(claude, "mine.mdc")}`));
    assert.match(out, new RegExp(`skipped real file ${join(kiro, "mine.md")}`));
  });
});

test("a kit without rules/index.md skips rules with a message and exits 0", () => {
  withRoot((root) => {
    const kit = join(root, "kit");
    const home = join(root, "home");
    mkdirSync(home);
    write(join(kit, "skills/plan/a/SKILL.md"), "a");

    const result = runLinkKit(home, kit);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no rules\/index\.md, rules skipped/);
    assert.deepEqual(readdirSync(join(home, ".claude")), ["skills"]);
  });
});

test("a listed rule missing from rules/ exits 1 naming it and writes nothing", () => {
  withRoot((root) => {
    const kit = rulesKit(root, ["- @~/.claude/rules/x.mdc", "- @~/.claude/rules/missing.mdc"]);
    const home = join(root, "home");
    mkdirSync(home);

    const result = runLinkKit(home, kit);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("missing.mdc"), result.stderr);
    assert.deepEqual(readdirSync(home), []);
  });
});

// Every path under `dir` with its type, symlink target or file content.
function snapshot(dir, base = dir) {
  const entries = {};
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    const key = path.slice(base.length) || "/";
    if (stat.isSymbolicLink()) entries[key] = `link -> ${readlinkSync(path)}`;
    else if (stat.isDirectory()) Object.assign(entries, { [key]: "dir" }, snapshot(path, base));
    else entries[key] = `file: ${readFileSync(path, "utf8")}`;
  }
  return entries;
}

test("--dry-run changes nothing in the home folder and prints the would-be actions", () => {
  withRoot((root) => {
    const kit = rulesKit(root);
    const home = join(root, "home");
    const skills = join(home, ".claude/skills");
    mkdirSync(skills, { recursive: true });
    symlinkSync(join(root, "elsewhere/skillsync/skills/old"), join(skills, "old"));
    write(join(home, ".claude/rules/mine.mdc"), "mine");
    const before = snapshot(home);

    const result = runLinkKit(home, kit, "--dry-run");
    assert.equal(result.status, 0, result.stderr);

    assert.deepEqual(snapshot(home), before);
    assert.equal(lstatSync(join(home, ".kiro"), { throwIfNoEntry: false }), undefined);
    assert.match(result.stdout, new RegExp(`removed stale ${join(skills, "old")}`));
    assert.match(result.stdout, new RegExp(`linked ${join(skills, "a")} -> ${join(kit, "skills/plan/a")}`));
    assert.match(result.stdout, new RegExp(`linked ${join(home, ".claude/rules/x.mdc")}`));
    assert.match(result.stdout, new RegExp(`linked ${join(home, ".kiro/steering/x.md")}`));
  });
});
