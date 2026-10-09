import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  phaseLabel,
  type EpicStory,
  type HarnessLoopState,
  type HarnessRepo,
  type HarnessTracker,
} from "../shared/orchestration";

// The plugin owns the initiative layout; every repo stores it in its own .harness:
//
//   .harness/initiatives/<slug>/
//     initiative.md                 frontmatter tracker (local | jira), title, outcome; the phases
//                                   and their stories between the harness markers (generated)
//     phases/<n>-<phase-slug>/
//       phase.md                    frontmatter phase (its number) + title
//       architecture.md             written by the architecture session (server/harness-architect.ts)
//       stories/                    one .md per story; frontmatter id, title, status, depends_on;
//                                   the initiative loop adds branch, workspace, agent, pr, ci, …
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
export const dirsIn = (dir: string) =>
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

// The initiative loop (server/initiative-loop.ts) runs while this is "on"; "done" once every phase merged.
export const initiativeLoopState = (dir: string): HarnessLoopState => {
  const value = frontmatter(readText(join(dir, "initiative.md"))).loop;
  return value === "on" || value === "done" ? value : "off";
};

// Sets (or, with null, removes) a file's frontmatter keys in place, keeping every other line as it was.
export function writeFrontmatter(file: string, patch: Record<string, string | number | null>) {
  const text = readText(file);
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  const lines = match ? match[1].split("\n") : [];
  for (const [key, raw] of Object.entries(patch)) {
    const at = lines.findIndex((line) => line.slice(0, line.indexOf(":")).trim() === key);
    if (raw === null) {
      if (at >= 0) lines.splice(at, 1);
      continue;
    }
    const line = `${key}: ${String(raw).replace(/\n/g, " ")}`;
    if (at >= 0) lines[at] = line;
    else lines.push(line);
  }
  const block = `---\n${lines.join("\n")}\n---`;
  const next = match ? text.replace(match[0], block) : `${block}\n\n${text}`;
  if (next !== text) writeFileSync(file, next, "utf8");
}

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

// A phase's story files in file order (which is priority), with their raw frontmatter.
export function readStoryFiles(epicDir: string) {
  const storiesDir = join(epicDir, "stories");
  const files = existsSync(storiesDir)
    ? readdirSync(storiesDir)
        .filter((file) => file.endsWith(".md"))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    : [];
  return files.map((file) => {
    const path = join(storiesDir, file);
    const text = readText(path);
    const meta = frontmatter(text);
    return { path, id: meta.id || file.replace(/\.md$/, ""), meta, body: text.replace(/^---\n[\s\S]*?\n---\n?/, "") };
  });
}

// A phase's stories from stories/*.md, in file order (which is priority).
export function readStories(epicDir: string): EpicStory[] {
  const raw = readStoryFiles(epicDir).map(({ path, meta }) => ({ file: path.split(sep).pop() ?? path, meta }));
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
      blockedFrom: story.blocked_from ?? "",
      skillWarnings: story.skill_warnings ?? "",
      discoveredFrom: story.discovered_from ?? "",
      pr: Number(story.pr) || null,
      ci: story.ci ?? "",
      workspace: story.workspace ?? "",
      agent: story.agent ?? "",
      ready: status === "todo" && !blockedBy && dependsOn.every((id) => merged.has(id)),
      track: story.track === "diagnose" ? ("diagnose" as const) : ("plan" as const),
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
              loop: initiativeLoopState(dir),
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

// .harness is local planning; keep it out of every commit. info/exclude lives in the common git
// dir, so this covers every worktree of the repo too.
export function excludeHarness(root: string) {
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

// A one-story initiative for a Jira ticket: `<key>-<summary slug>`, Phase 1, story S1 carrying the
// ticket. Bugs take the Diagnose track. A ticket that already has an initiative reuses it as is.
export async function createTicketInitiative(input: {
  repo: string;
  key: string;
  summary: string;
  url: string;
  issueType: string;
}) {
  const track: "plan" | "diagnose" = input.issueType.trim().toLowerCase() === "bug" ? "diagnose" : "plan";
  try {
    const root = resolve(input.repo);
    const key = input.key.trim().toUpperCase();
    const existing = dirsIn(initiativesDir(root)).find((name) => name.startsWith(`${key.toLowerCase()}-`));
    if (existing) return { ok: true, error: null, initiative: existing, track };

    const summary = input.summary.replace(/\s+/g, " ").trim();
    const created = await createHarnessEpic({
      repo: root,
      initiative: "",
      initiativeTitle: `${key} — ${summary}`,
      epicTitle: summary,
      tracker: "local",
    });
    if (!created.ok || !created.epic) throw new Error(created.error ?? "Could not create the initiative.");
    const epicDir = join(root, created.epic);
    const initiative = relative(initiativesDir(root), join(epicDir, "..", "..")).split(sep).join("/");
    writeFileSync(
      join(epicDir, "stories", `01-${slugOf(summary)}.md`),
      `---\nid: S1\ntitle: ${summary}\nstatus: todo\njira: ${key}\njira_url: ${input.url}\n${track === "diagnose" ? "track: diagnose\n" : ""}---\n\n# S1 — ${summary}\n\n${summary}\n\nJira: [${key}](${input.url})\n`,
      "utf8",
    );
    refreshInitiativeIndex(join(initiativesDir(root), initiative));
    return { ok: true, error: null, initiative, track };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause), initiative: null, track };
  }
}
