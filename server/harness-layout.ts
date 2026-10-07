import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HarnessRepo } from "../shared/orchestration";

// The plugin owns the initiative layout; every repo stores it in its own .harness:
//
//   .harness/initiatives/<slug>/
//     initiative.md                 title + outcome; epics table between the harness markers
//     epics/E<n>-<epic-slug>/
//       epic.md                     frontmatter id + title
//       stories/                    one .md per story; frontmatter id, title, status, depends_on
//       state/                      per-story working notes, written by whatever runs the story
//
// Planning tools and runners read this layout and add stories to it; they don't create it.

const EPICS_START = "<!-- harness:epics:start -->";
const EPICS_END = "<!-- harness:epics:end -->";
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export const slugOf = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");

export const frontmatter = (text: string) => {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  return Object.fromEntries(
    block.split("\n").flatMap((line) => {
      const at = line.indexOf(":");
      return at > 0 ? [[line.slice(0, at).trim(), line.slice(at + 1).trim()]] : [];
    }),
  ) as Record<string, string>;
};

const readText = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
const dirsIn = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    : [];

export const initiativesDir = (root: string) => join(root, ".harness", "initiatives");

// The absolute epic folder for a repo-relative path, or null unless it is an epic
// (has epic.md) inside .harness/initiatives.
export function epicDirFor(root: string, epic: string) {
  const target = resolve(root, epic);
  const rel = relative(initiativesDir(root), target);
  if (!rel || isAbsolute(rel) || rel.split(sep)[0] === ".." || !existsSync(join(target, "epic.md"))) return null;
  return target;
}

export function listHarness(repos: string[]): { repos: HarnessRepo[] } {
  const unique = [...new Set(repos.filter(Boolean).map((repo) => resolve(repo)))];
  return {
    repos: unique
      .filter((root) => existsSync(join(root, ".git")))
      .map((root) => {
        const base = initiativesDir(root);
        return {
          repo: root,
          name: root.split(sep).pop() ?? root,
          initiatives: dirsIn(base).map((slug) => {
            const dir = join(base, slug);
            const title = /^# (?:Initiative: )?(.+)$/m.exec(readText(join(dir, "initiative.md")))?.[1] ?? slug;
            return {
              slug,
              title,
              epics: dirsIn(join(dir, "epics")).map((name) => {
                const epicDir = join(dir, "epics", name);
                const meta = frontmatter(readText(join(epicDir, "epic.md")));
                const stories = existsSync(join(epicDir, "stories"))
                  ? readdirSync(join(epicDir, "stories")).filter((file) => file.endsWith(".md"))
                  : [];
                const merged = stories.filter(
                  (file) => frontmatter(readText(join(epicDir, "stories", file))).status === "merged",
                ).length;
                return {
                  id: meta.id || name.split("-")[0],
                  title: meta.title || name,
                  path: relative(root, epicDir).split(sep).join("/"),
                  stories: stories.length,
                  merged,
                };
              }),
            };
          }),
        };
      }),
  };
}

function epicsTable(dir: string) {
  const rows = dirsIn(join(dir, "epics")).map((name) => {
    const meta = frontmatter(readText(join(dir, "epics", name, "epic.md")));
    return `| ${meta.id || name} — ${meta.title || name} | [\`epics/${name}/epic.md\`](epics/${name}/epic.md) |`;
  });
  return [EPICS_START, "| Epic | Path |", "|------|------|", ...rows, EPICS_END].join("\n");
}

function refreshEpicsTable(dir: string) {
  const file = join(dir, "initiative.md");
  const text = readText(file);
  const table = epicsTable(dir);
  const start = text.indexOf(EPICS_START);
  const end = text.indexOf(EPICS_END);
  const next =
    start >= 0 && end > start
      ? text.slice(0, start) + table + text.slice(end + EPICS_END.length)
      : `${text.trimEnd()}\n\n## Epics\n\n${table}\n`;
  writeFileSync(file, next, "utf8");
}

// .harness is local planning; keep it out of every commit.
function excludeHarness(root: string) {
  return new Promise<void>((done) => {
    execFile("git", ["rev-parse", "--git-common-dir"], { cwd: root, timeout: 10_000 }, (error, stdout) => {
      if (!error) {
        const common = stdout.trim();
        const file = join(isAbsolute(common) ? common : join(root, common), "info", "exclude");
        const text = readText(file);
        if (!/^\/?\.harness\/?$/m.test(text)) {
          mkdirSync(dirname(file), { recursive: true });
          appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}.harness/\n`, "utf8");
        }
      }
      done();
    });
  });
}

// Creates the initiative when it's new, then its next epic. Returns the epic's repo-relative path.
export async function createHarnessEpic(input: {
  repo: string;
  initiative: string;
  initiativeTitle: string;
  epicTitle: string;
}) {
  try {
    const root = resolve(input.repo);
    if (!existsSync(join(root, ".git"))) throw new Error(`${root} is not a git repo.`);
    const slug = input.initiative || slugOf(input.initiativeTitle);
    if (!SLUG.test(slug)) throw new Error("Give the initiative a name with letters or numbers.");
    const epicTitle = input.epicTitle.trim();
    const epicSlug = slugOf(epicTitle);
    if (!epicSlug) throw new Error("Give the epic a name with letters or numbers.");

    const dir = join(initiativesDir(root), slug);
    if (!existsSync(join(dir, "initiative.md"))) {
      const title = input.initiativeTitle.trim() || slug;
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "initiative.md"),
        `# Initiative: ${title}\n\n> **Slug:** \`${slug}\`\n\n## Outcome\n\n_What is true when this initiative is done._\n`,
        "utf8",
      );
    }

    const taken = dirsIn(join(dir, "epics")).map((name) => Number(/^E(\d+)-/.exec(name)?.[1] ?? 0));
    const id = `E${Math.max(0, ...taken) + 1}`;
    const epicDir = join(dir, "epics", `${id}-${epicSlug}`);
    mkdirSync(join(epicDir, "stories"), { recursive: true });
    mkdirSync(join(epicDir, "state"), { recursive: true });
    writeFileSync(
      join(epicDir, "epic.md"),
      `---\nid: ${id}\ntitle: ${epicTitle}\n---\n\n# ${id} — ${epicTitle}\n\n## Goal\n\n_One file per story in stories/, in priority order._\n`,
      "utf8",
    );
    refreshEpicsTable(dir);

    const epic = relative(root, epicDir).split(sep).join("/");
    await excludeHarness(root);
    return { ok: true, error: null, epic };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause), epic: null };
  }
}
