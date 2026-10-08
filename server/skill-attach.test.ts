import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { PluginAttachmentSearchPayloadSchema } from "@getpaseo/plugin";
import { MACHINE_SOURCE, type SkillSource } from "../shared/pipeline";
import { attachmentUrl, attachSkills } from "./skill-attach";
import { sourceId } from "./skill-sources";

const NAME = "vercel-react-best-practices";
const FOLDER = "react-best-practices";
const DESCRIPTION = "React and Next.js performance rules from Vercel.";
const BODY = "# React best practices\n\nRead references/rules.md before changing components.\n";

let root: string;
let home: string;
let fixture: SkillSource;

// A folder source built from `{ relative path: contents }`.
async function folderSource(name: string, files: Record<string, string>): Promise<SkillSource> {
  const location = join(root, name);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(location, path)), { recursive: true });
    await writeFile(join(location, path), text);
  }
  return { id: sourceId(location), label: name, location, kind: "personal", enabled: true, pin: null };
}

// Runs `fn` with HOME pointed at `dir`, restoring it (or unsetting it) afterwards.
async function withHome<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.HOME;
  process.env.HOME = dir;
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

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "orchestrator-skill-attach-")));
  // An empty HOME keeps this machine's own skills out of the results.
  home = join(root, "empty-home");
  await mkdir(home, { recursive: true });
  fixture = await folderSource("source", {
    [`skills/${FOLDER}/SKILL.md`]: `---\nname: ${NAME}\ndescription: ${DESCRIPTION}\n---\n${BODY}`,
    [`skills/${FOLDER}/references/rules.md`]: "- Avoid waterfalls.\n",
  });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a folder skill attaches with its body and the absolute paths of its files", async () => {
  const { items } = await withHome(home, () => attachSkills("react", [fixture]));

  assert.equal(items.length, 1);
  const [item] = items;
  assert.ok(item);
  assert.equal(item.id, `${fixture.id}:${NAME}`);
  assert.equal(item.identifier, `${fixture.id}:${NAME}`);
  assert.equal(item.title, NAME);
  assert.equal(item.subtitle, `source · ${DESCRIPTION}`);
  assert.equal(item.resourceType, "skill");
  assert.equal(item.url, pathToFileURL(join(fixture.location, "skills", FOLDER)).href);
  assert.ok(item.text.startsWith(`Skill: ${NAME} — from source\n`), item.text);
  assert.ok(item.text.includes(BODY), "expected the SKILL.md body");
  assert.ok(
    item.text.includes(`## Files in this skill\n\n- ${join(fixture.location, "skills", FOLDER, "references", "rules.md")}`),
    item.text,
  );
  assert.ok(PluginAttachmentSearchPayloadSchema.safeParse({ items }).success, "a valid attachment payload");
});

test("a query matches by name, folder or description, with name and folder matches first", async () => {
  const source = await folderSource("matching", {
    "skills/aaa-notes/SKILL.md": "---\nname: aaa-notes\ndescription: Keeps a grill log.\n---\nBody\n",
    "skills/grill-folder/SKILL.md": "---\nname: interrogate\ndescription: Ask questions.\n---\nBody\n",
    "skills/zzz-grill/SKILL.md": "---\nname: zzz-grill\ndescription: Grill a plan.\n---\nBody\n",
    "skills/other/SKILL.md": "---\nname: other\ndescription: Unrelated.\n---\nBody\n",
  });

  const { items } = await withHome(home, () => attachSkills("GRILL", [source]));

  assert.deepEqual(
    items.map((i) => i.title),
    ["interrogate", "zzz-grill", "aaa-notes"],
  );
});

test("a blank query lists skills up to the limit, and the limit caps any query", async () => {
  const files: Record<string, string> = {};
  for (const n of ["a", "b", "c", "d"]) {
    files[`skills/skill-${n}/SKILL.md`] = `---\nname: skill-${n}\n---\nBody\n`;
  }
  const source = await folderSource("many", files);

  const blank = await withHome(home, () => attachSkills("  ", [source], { limit: 3 }));
  const capped = await withHome(home, () => attachSkills("skill", [source], { limit: 2 }));
  const all = await withHome(home, () => attachSkills("", [source]));

  assert.deepEqual(blank.items.map((i) => i.title), ["skill-a", "skill-b", "skill-c"]);
  assert.deepEqual(capped.items.map((i) => i.title), ["skill-a", "skill-b"]);
  assert.equal(all.items.length, 4);
});

test("a skill installed on this machine attaches as This machine with a file:// url", async () => {
  const machine = await folderSource("machine-home", {
    ".claude/skills/grill/SKILL.md": "---\nname: grill-me\ndescription: Grill a plan.\n---\nAsk hard questions.\n",
  });

  const { items } = await withHome(machine.location, () => attachSkills("grill", []));

  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, `${MACHINE_SOURCE}:grill-me`);
  assert.equal(items[0]?.subtitle, "This machine · Grill a plan.");
  assert.equal(items[0]?.url, pathToFileURL(join(machine.location, ".claude", "skills", "grill")).href);
  assert.ok(items[0]?.text.startsWith("Skill: grill-me — from This machine\n"), items[0]?.text);
});

test("a command attaches with its body and no file list", async () => {
  const source = await folderSource("commands", {
    "commands/ss-ship.md": "---\ndescription: Ship it.\n---\nOpen the PR.\n",
  });

  const { items } = await withHome(home, () => attachSkills("ship", [source]));

  assert.equal(items.length, 1);
  assert.equal(items[0]?.resourceType, "command");
  assert.equal(items[0]?.text, "Command: ss-ship — from commands\n\nOpen the PR.\n");
});

test("a GitHub source links to its repo; anything else links to the skill folder", () => {
  const path = join(root, "checkout", "skills", "tdd");
  const file = pathToFileURL(path).href;

  for (const location of [
    "vercel-labs/agent-skills",
    "https://github.com/vercel-labs/agent-skills.git",
    "https://github.com/vercel-labs/agent-skills",
    "git@github.com:vercel-labs/agent-skills.git",
  ]) {
    assert.equal(attachmentUrl(location, path), "https://github.com/vercel-labs/agent-skills", location);
  }
  for (const location of ["https://gitlab.com/team/skills.git", "git@example.com:team/skills.git", root]) {
    assert.equal(attachmentUrl(location, path), file, location);
  }
});

test("a pinned source names its short pin in the header", async () => {
  const pinned = { ...fixture, label: "vercel-labs/agent-skills", pin: "0123456789abcdef0123456789abcdef01234567" };

  const { items } = await withHome(home, () => attachSkills("react", [pinned]));

  assert.ok(
    items[0]?.text.startsWith(`Skill: ${NAME} — from vercel-labs/agent-skills @ 0123456\n`),
    items[0]?.text,
  );
});

test("a skill that cannot be read is left out and the rest still attach", async () => {
  const source = await folderSource("unreadable", {
    "skills/locked/SKILL.md": "---\nname: locked\n---\nSecret\n",
    "skills/open/SKILL.md": "---\nname: open\n---\nBody\n",
  });
  await chmod(join(source.location, "skills", "locked", "SKILL.md"), 0o000);
  try {
    const { items } = await withHome(home, () => attachSkills("", [source]));

    assert.deepEqual(items.map((i) => i.title), ["open"]);
  } finally {
    await chmod(join(source.location, "skills", "locked", "SKILL.md"), 0o644);
  }
});

test("an off source or a missing folder contributes nothing", async () => {
  const off = { ...fixture, enabled: false };
  const missing = { ...fixture, id: "missing", location: join(root, "no-such-folder") };

  const { items } = await withHome(home, () => attachSkills("", [off, missing]));

  assert.deepEqual(items, []);
});

test("a catalog failure returns no items instead of throwing", async () => {
  const broken = [null] as unknown as SkillSource[];

  const result = await withHome(home, () => attachSkills("react", broken));

  assert.deepEqual(result, { items: [] });
});
