import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { SkillSource } from "../shared/belt";
import { installSkills, loadCatalog, readSkill, sourceId } from "./skill-sources";

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

async function storyWorktree() {
  const cwd = await mkdtemp(join(root, "worktree-"));
  execFileSync("git", ["init", "--quiet"], { cwd });
  return cwd;
}

// The copy is named after the frontmatter `name`, whichever name the ref uses.
for (const refName of [NAME, FOLDER]) {
  test(`a ref named "${refName}" installs the skill as .claude/skills/${NAME}`, async () => {
    const cwd = await storyWorktree();

    const warnings = await installSkills(cwd, [{ name: refName, source: fixture.id }], [fixture]);

    assert.deepEqual(warnings, []);
    const copied = await readFile(join(cwd, ".claude", "skills", NAME, "SKILL.md"), "utf8").catch(() => null);
    assert.ok(copied?.includes(BODY), `expected .claude/skills/${NAME}/SKILL.md in the worktree`);
  });
}

test("readSkill returns the body after the frontmatter and a manifest of the other files", async () => {
  const content = await readSkill({ name: NAME, source: fixture.id }, [fixture]);

  assert.deepEqual(content, {
    name: NAME,
    description: DESCRIPTION,
    body: BODY,
    files: [join(fixture.location, "skills", FOLDER, "references", "rules.md")],
    commit: null,
  });
});
