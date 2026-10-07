import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { MACHINE_SOURCE, type SkillSource } from "../shared/belt";
import {
  addSource,
  installSkills,
  loadCatalog,
  readFrontmatter,
  readSkill,
  readSkills,
  SOURCES_ROOT,
  sourceId,
} from "./skill-sources";

// A folder source whose skill folder name differs from its frontmatter `name`, as
// vercel-labs/agent-skills does.
const NAME = "vercel-react-best-practices";
const FOLDER = "react-best-practices";
const DESCRIPTION = "React and Next.js performance rules from Vercel.";
const BODY = "# React best practices\n\nRead references/rules.md before changing components.\n";

let root: string;
let fixture: SkillSource;

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "orchestrator-skill-sources-")));
  const location = join(root, "source");
  const skill = join(location, "skills", FOLDER);
  await mkdir(join(skill, "references"), { recursive: true });
  await writeFile(join(skill, "SKILL.md"), `---\nname: ${NAME}\ndescription: ${DESCRIPTION}\n---\n${BODY}`);
  await writeFile(join(skill, "references", "rules.md"), "- Avoid waterfalls.\n");
  fixture = {
    id: sourceId(location),
    label: "source",
    location,
    kind: "personal",
    enabled: true,
    pin: null,
  };
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("catalog names a skill by its frontmatter name and keeps its folder", async () => {
  const { skills } = await loadCatalog([fixture]);

  assert.deepEqual(
    skills.filter((s) => s.source === fixture.id),
    [{ name: NAME, folder: FOLDER, description: DESCRIPTION, source: fixture.id, kind: "skill" }],
  );
});

// A folder source built from `{ relative path: contents }`.
async function folderSource(name: string, files: Record<string, string>): Promise<SkillSource> {
  const location = join(root, name);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(location, path)), { recursive: true });
    await writeFile(join(location, path), text);
  }
  return { id: sourceId(location), label: name, location, kind: "personal", enabled: true, pin: null };
}

// Runs `fn` with HOME pointed at `home`, restoring it (or unsetting it) afterwards.
async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    if (saved === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = saved;
    }
  }
}

test("a folded `description: >-` block reads as one line", async () => {
  const source = await folderSource("folded", {
    "skills/tdd/SKILL.md": "---\nname: tdd\ndescription: >-\n  Red, green,\n  refactor.\nlicense: MIT\n---\nBody\n",
  });

  const { skills } = await loadCatalog([source]);

  assert.deepEqual(
    skills.filter((s) => s.source === source.id),
    [{ name: "tdd", folder: "tdd", description: "Red, green, refactor.", source: source.id, kind: "skill" }],
  );
});

test("a skill without frontmatter is named by its folder with no description", async () => {
  const source = await folderSource("bare", { "plain-skill/SKILL.md": "# Just a body\n" });

  const { skills } = await loadCatalog([source]);

  assert.deepEqual(
    skills.filter((s) => s.source === source.id),
    [{ name: "plain-skill", folder: "plain-skill", description: "", source: source.id, kind: "skill" }],
  );
});

test("installed skills carry their frontmatter name, folder and description", async () => {
  const home = await folderSource("home", {
    ".claude/skills/review-folder/SKILL.md": "---\nname: ss-review-skill\ndescription: Review a branch.\n---\n",
    ".agents/skills/plain/SKILL.md": "# no frontmatter\n",
    ".claude/commands/ss-plan.md": "---\ndescription: 'Plan a story.'\n---\nPlan it.\n",
  });
  await withHome(home.location, async () => {
    const { skills } = await loadCatalog([]);

    assert.deepEqual(skills, [
      { name: "plain", folder: "plain", description: "", source: MACHINE_SOURCE, kind: "skill" },
      { name: "ss-plan", folder: "ss-plan", description: "Plan a story.", source: MACHINE_SOURCE, kind: "command" },
      {
        name: "ss-review-skill",
        folder: "review-folder",
        description: "Review a branch.",
        source: MACHINE_SOURCE,
        kind: "skill",
      },
    ]);
  });
});

test("a skillsync-style folder lists skills nested under category folders", async () => {
  const source = await folderSource("skillsync-skills", {
    "engineering/tdd-folder/SKILL.md": "---\nname: tdd\ndescription: >\n  Red, green.\n---\n",
    "productivity/grill/SKILL.md": "---\nname: grill-me\ndescription: Grill a plan.\n---\n",
    "personal/journal/SKILL.md": "---\nname: journal-weekly\ndescription: \"Weekly notes.\"\n---\n",
  });

  const added = await addSource(source.location);
  const { skills } = await loadCatalog([source]);

  assert.equal(added.skillCount, 3);
  assert.deepEqual(
    skills.filter((s) => s.source === source.id).map((s) => [s.name, s.folder, s.description]),
    [
      ["grill-me", "grill", "Grill a plan."],
      ["journal-weekly", "journal", "Weekly notes."],
      ["tdd", "tdd-folder", "Red, green."],
    ],
  );
});

async function storyWorktree() {
  const cwd = await mkdtemp(join(root, "worktree-"));
  execFileSync("git", ["init", "--quiet"], { cwd });
  return cwd;
}

// The copy keeps the skill's folder name, whichever name the ref uses.
for (const refName of [NAME, FOLDER]) {
  test(`a ref named "${refName}" installs the skill as .claude/skills/${FOLDER}`, async () => {
    const cwd = await storyWorktree();

    const warnings = await installSkills(cwd, [{ name: refName, source: fixture.id }], [fixture]);

    assert.deepEqual(warnings, []);
    const copied = await readFile(join(cwd, ".claude", "skills", FOLDER, "SKILL.md"), "utf8").catch(() => null);
    assert.ok(copied?.includes(BODY), `expected .claude/skills/${FOLDER}/SKILL.md in the worktree`);
  });
}

test("a ref matching neither the name nor the folder warns not found", async () => {
  const cwd = await storyWorktree();

  const warnings = await installSkills(cwd, [{ name: "missing-skill", source: fixture.id }], [fixture]);

  assert.deepEqual(warnings, ["missing-skill: not found in source."]);
});

test("readSkill returns the body after the frontmatter and a manifest of the other files", async () => {
  const content = await readSkill({ name: NAME, source: fixture.id }, [fixture]);

  assert.deepEqual(content, {
    name: NAME,
    description: DESCRIPTION,
    body: BODY,
    files: [join(fixture.location, "skills", FOLDER, "references", "rules.md")],
    commit: null,
    path: join(fixture.location, "skills", FOLDER),
  });
});

test("readSkill finds the same skill by its folder name", async () => {
  const content = await readSkill({ name: FOLDER, source: fixture.id }, [fixture]);

  assert.ok(!("error" in content), "expected the skill content");
  assert.equal(content.name, NAME);
  assert.equal(content.body, BODY);
});

test("readSkill returns a command's body with no other files", async () => {
  const source = await folderSource("commands-source", {
    "commands/ss-ship.md": "---\ndescription: Ship it.\n---\nOpen the PR.\n",
  });

  const content = await readSkill({ name: "ss-ship", source: source.id }, [source]);

  assert.deepEqual(content, {
    name: "ss-ship",
    description: "Ship it.",
    body: "Open the PR.\n",
    files: [],
    commit: null,
    path: join(source.location, "commands", "ss-ship.md"),
  });
});

test("readSkill reads an installed skill from this machine", async () => {
  const home = await folderSource("read-home", {
    ".claude/skills/grill/SKILL.md": "---\nname: grill-me\ndescription: Grill a plan.\n---\nAsk hard questions.\n",
    ".claude/skills/grill/notes/one.md": "one\n",
  });
  await withHome(home.location, async () => {
    const content = await readSkill({ name: "grill-me", source: MACHINE_SOURCE }, []);

    assert.deepEqual(content, {
      name: "grill-me",
      description: "Grill a plan.",
      body: "Ask hard questions.\n",
      files: [join(home.location, ".claude", "skills", "grill", "notes", "one.md")],
      commit: null,
      path: join(home.location, ".claude", "skills", "grill"),
    });
  });
});

test("readSkill never clones a source that is not connected or is off", async () => {
  const id = sourceId(`orchestrator-test/not-connected-${Date.now()}`);
  const off: SkillSource = { id, label: "off", location: `orchestrator-test/${id}`, kind: "team", enabled: false, pin: null };

  for (const sources of [[], [off]]) {
    const content = await readSkill({ name: "anything", source: id }, sources);

    assert.ok("error" in content, "expected an error");
  }
  assert.equal(await stat(join(SOURCES_ROOT, id)).catch(() => null), null, "no checkout directory");
});

test("readSkills reads many refs in order, with an error for each one that can't be read", async () => {
  const other = await folderSource("read-many", {
    "skills/one/SKILL.md": "---\nname: one\n---\nOne\n",
    "skills/two/SKILL.md": "---\nname: two\n---\nTwo\n",
  });

  const contents = await readSkills(
    [
      { name: "two", source: other.id },
      { name: NAME, source: fixture.id },
      { name: "missing", source: other.id },
      { name: "one", source: other.id },
      { name: "anything", source: "not-connected" },
    ],
    [fixture, other],
  );

  assert.deepEqual(
    contents.map((c) => ("error" in c ? c.error : c.body)),
    [
      "Two\n",
      BODY,
      `missing: not found in ${other.id}.`,
      "One\n",
      'anything: source "not-connected" is not connected or is off.',
    ],
  );
});

test("a plain frontmatter value drops a trailing # comment", () => {
  const commented = readFrontmatter("---\ndescription: Plan a story. # shown in the picker\n---\n");

  assert.equal(commented.description, "Plan a story.");
  assert.equal(readFrontmatter("---\nname: c#-tips\n---\n").name, "c#-tips");
});

test("readSkill lists only files inside the skill folder, without following links out or in loops", async () => {
  const outside = await folderSource("outside", { "secret.md": "not part of the skill\n" });
  const source = await folderSource("linked", {
    "skills/linked/SKILL.md": "---\nname: linked\n---\nBody\n",
    "skills/linked/refs/a.md": "a\n",
  });
  const skill = join(source.location, "skills", "linked");
  await symlink(outside.location, join(skill, "escape"));
  await symlink(skill, join(skill, "refs", "loop"));
  await symlink(join(skill, "refs"), join(skill, "alias"));
  await symlink(join(outside.location, "secret.md"), join(skill, "leak.md"));

  const content = await readSkill({ name: "linked", source: source.id }, [source]);

  assert.ok(!("error" in content), `expected the skill content, got ${JSON.stringify(content)}`);
  assert.deepEqual(content.files, [join(skill, "refs", "a.md")]);
});
