import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { phaseLabel, type EpicStory, type HarnessRepo, type HarnessTracker } from "../shared/orchestration";

// The plugin owns the initiative layout; every repo stores it in its own .harness:
//
//   .harness/initiatives/<slug>/
//     initiative.md                 frontmatter tracker (local | jira), title, outcome; the phases
//                                   and their stories between the harness markers (generated)
//     phases/<n>-<phase-slug>/
//       phase.md                    frontmatter phase (its number) + title
//       architecture.md             written by the architecture session (server/harness-architect.ts)
//       stories/                    one .md per story; frontmatter id, title, status, depends_on
//
// The architecture session (server/harness-architect.ts) adds the plan and stories to it.

const PHASES_START = "<!-- harness:phases:start -->";
const PHASES_END = "<!-- harness:phases:end -->";
export const PHASES_DIR = "phases";
export const PHASE_FILE = "phase.md";
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

export const initiativeTitle = (dir: string) =>
  /^# (?:Initiative: )?(.+)$/m.exec(readText(join(dir, "initiative.md")))?.[1] ?? dir.split(sep).pop() ?? "";

export const initiativeTracker = (dir: string): HarnessTracker =>
  frontmatter(readText(join(dir, "initiative.md"))).tracker === "jira" ? "jira" : "local";

const list = (value: string | undefined) => (value ? value.split(",").map((part) => part.trim()).filter(Boolean) : []);

// Sets frontmatter fields in place (adding any that are missing); returns the text unchanged
// when it has no frontmatter.
export function setFrontmatter(md: string, values: Record<string, string>) {
  const end = md.startsWith("---") ? md.indexOf("\n---", 3) : -1;
  if (end === -1) return md;
  let head = md.slice(0, end);
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}: ${value}`;
    const pattern = new RegExp(`^${key}:.*$`, "m");
    head = pattern.test(head) ? head.replace(pattern, line) : `${head}\n${line}`;
  }
  return head + md.slice(end);
}

export function writeFrontmatter(file: string, values: Record<string, string>) {
  const text = readText(file);
  const next = setFrontmatter(text, values);
  if (next !== text) writeFileSync(file, next, "utf8");
}

// A phase's story files with their frontmatter, in file order (which is priority).
export function storyFiles(epicDir: string) {
  const storiesDir = join(epicDir, "stories");
  const files = existsSync(storiesDir)
    ? readdirSync(storiesDir)
        .filter((file) => file.endsWith(".md"))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    : [];
  return files.map((file) => ({ file: join(storiesDir, file), name: file, meta: frontmatter(readText(join(storiesDir, file))) }));
}

// A phase's stories, in priority order.
export function readStories(epicDir: string): EpicStory[] {
  const raw = storyFiles(epicDir).map(({ name, meta }) => ({ file: name, meta }));
  const merged = new Set(raw.filter((story) => story.meta.status === "merged").map((story) => story.meta.id));
  return raw.map(({ file, meta: story }) => {
    const dependsOn = list(story.depends_on);
    const status = story.status || "todo";
    const blockedBy = story.blocked_by ?? "";
    return {
      id: story.id || file.replace(/\.md$/, ""),
      title: story.title || file,
      status,
      dependsOn,
      blockedBy,
      blockedReason: story.blocked_reason ?? "",
      discoveredFrom: story.discovered_from ?? "",
      pr: Number(story.pr) || null,
      ready: status === "todo" && !blockedBy && dependsOn.every((id) => merged.has(id)),
    };
  });
}

// The absolute epic folder for a repo-relative path, or null unless it is an epic
// (has phase.md) inside .harness/initiatives.
export function epicDirFor(root: string, epic: string) {
  const target = resolve(root, epic);
  const rel = relative(initiativesDir(root), target);
  if (!rel || isAbsolute(rel) || rel.split(sep)[0] === ".." || !existsSync(join(target, PHASE_FILE))) return null;
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
            return {
              slug,
              title: initiativeTitle(dir),
              tracker: initiativeTracker(dir),
              epics: dirsIn(join(dir, PHASES_DIR)).map((name) => {
                const epicDir = join(dir, PHASES_DIR, name);
                const meta = frontmatter(readText(join(epicDir, PHASE_FILE)));
                const stories = readStories(epicDir);
                return {
                  id: meta.phase || name.split("-")[0],
                  title: meta.title || name,
                  path: relative(root, epicDir).split(sep).join("/"),
                  stories: stories.length,
                  merged: stories.filter((story) => story.status === "merged").length,
                };
              }),
            };
          }),
        };
      }),
  };
}

const cell = (text: string) => text.replace(/\|/g, "\\|");

// Every phase with its stories, between the markers in initiative.md. With a local tracker this
// is the initiative's epic-and-stories list; the files under phases/ stay the source.
function initiativeIndex(dir: string) {
  const phases = dirsIn(join(dir, PHASES_DIR)).map((name) => {
    const epicDir = join(dir, PHASES_DIR, name);
    const meta = frontmatter(readText(join(epicDir, PHASE_FILE)));
    return { name, label: `${phaseLabel(meta.phase || name)} — ${meta.title || name}`, stories: readStories(epicDir), epicDir };
  });
  const lines = [PHASES_START, "| Phase | Stories | Merged | Path |", "|-------|---------|--------|------|"];
  for (const phase of phases) {
    const file = `${PHASES_DIR}/${phase.name}/${PHASE_FILE}`;
    const merged = phase.stories.filter((story) => story.status === "merged").length;
    lines.push(`| ${cell(phase.label)} | ${phase.stories.length} | ${merged} | [\`${file}\`](${file}) |`);
  }
  for (const phase of phases) {
    lines.push("", `### ${phase.label}`, "");
    if (existsSync(join(phase.epicDir, "architecture.md"))) {
      lines.push(`Plan: [\`architecture.md\`](${PHASES_DIR}/${phase.name}/architecture.md)`, "");
    }
    if (phase.stories.length === 0) {
      lines.push("_No stories yet._");
      continue;
    }
    lines.push("| Story | Title | Status | Depends on |", "|-------|-------|--------|------------|");
    for (const story of phase.stories) {
      lines.push(`| ${cell(story.id)} | ${cell(story.title)} | ${story.status} | ${story.dependsOn.join(", ") || "—"} |`);
    }
  }
  lines.push(PHASES_END);
  return lines.join("\n");
}

// Rewrites the index in initiative.md; writes only when it changed, so it is cheap to call often.
export function refreshInitiativeIndex(dir: string) {
  const file = join(dir, "initiative.md");
  if (!existsSync(file)) return;
  const text = readText(file);
  const index = initiativeIndex(dir);
  const start = text.indexOf(PHASES_START);
  const end = text.indexOf(PHASES_END);
  const next =
    start >= 0 && end > start
      ? text.slice(0, start) + index + text.slice(end + PHASES_END.length)
      : `${text.trimEnd()}\n\n## Phases\n\n${index}\n`;
  if (next !== text) writeFileSync(file, next, "utf8");
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
  tracker?: HarnessTracker;
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
        `---\ntracker: ${input.tracker === "jira" ? "jira" : "local"}\n---\n\n# Initiative: ${title}\n\n> **Slug:** \`${slug}\`\n\n## Outcome\n\n_What is true when this initiative is done._\n`,
        "utf8",
      );
    }

    const taken = dirsIn(join(dir, PHASES_DIR)).map((name) => Number(/^(\d+)-/.exec(name)?.[1] ?? 0));
    const id = String(Math.max(0, ...taken) + 1);
    const epicDir = join(dir, PHASES_DIR, `${id}-${epicSlug}`);
    mkdirSync(join(epicDir, "stories"), { recursive: true });
    writeFileSync(
      join(epicDir, PHASE_FILE),
      `---\nphase: ${id}\ntitle: ${epicTitle}\n---\n\n# ${phaseLabel(id)} — ${epicTitle}\n\n## Goal\n\n_One file per story in stories/, in priority order._\n`,
      "utf8",
    );
    refreshInitiativeIndex(dir);

    const epic = relative(root, epicDir).split(sep).join("/");
    await excludeHarness(root);
    return { ok: true, error: null, epic };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause), epic: null };
  }
}
