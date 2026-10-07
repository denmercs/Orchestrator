import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EpicAction, EpicBoardState, EpicStory } from "../shared/orchestration";
import { epicDirFor, frontmatter, initiativesDir } from "./harness-layout";

// The board reads the active epic straight from the layout in server/harness-layout.ts. Running
// stories is optional: the `runner` setting names a module that exports
//
//   createHarnessRunner({ root, epicDir }) => {
//     state(): EpicBoardState without repoUrl/runner (live loop, sessions, previews, progress)
//     act(action, id?): Promise<{ code, body: { error?, url? } }>
//     stop(): void        // stop previews and anything else held in this process
//     reset?(): void      // forget loop state when the initiative is deleted
//   }
//
// Without a runner the board shows the plan only, and its run buttons stay hidden.

export type HarnessSettings = { repo: string; epic: string; runner: string };

type Runner = {
  state(): Omit<EpicBoardState, "repoUrl" | "runner">;
  act(action: string, id?: string): Promise<{ code: number; body: { error?: string; url?: string | null } }>;
  stop(): void;
  reset?(): void;
};

let current: { key: string; runner: Runner } | null = null;
const repoUrls = new Map<string, Promise<string>>();

function githubUrl(repo: string) {
  let url = repoUrls.get(repo);
  if (!url) {
    url = new Promise((done) => {
      execFile("gh", ["repo", "view", "--json", "url", "-q", ".url"], { cwd: repo, timeout: 15_000 }, (error, stdout) => {
        done(error ? "" : stdout.trim());
      });
    });
    repoUrls.set(repo, url);
  }
  return url;
}

function runnerFor(settings: HarnessSettings, root: string, epicDir: string) {
  if (!settings.runner) return null;
  const file = resolve(settings.runner.replace(/^~(?=\/)/, homedir()));
  const key = `${file}\n${epicDir}`;
  if (current?.key !== key) {
    current?.runner.stop();
    current = null;
    if (!existsSync(file)) throw new Error(`Runner ${file} not found. Fix it in the harness settings.`);
    const mod = createRequire(file)(file) as { createHarnessRunner?: (opts: { root: string; epicDir: string }) => Runner };
    if (typeof mod.createHarnessRunner !== "function") throw new Error(`${file} does not export createHarnessRunner.`);
    current = { key, runner: mod.createHarnessRunner({ root, epicDir }) };
  }
  return current.runner;
}

const list = (value: string | undefined) => (value ? value.split(",").map((part) => part.trim()).filter(Boolean) : []);

// The plan alone, read from the epic's stories/ (file order is priority).
function readPlan(root: string, epicDir: string): Omit<EpicBoardState, "repoUrl" | "runner"> {
  const meta = frontmatter(readFileSync(join(epicDir, "epic.md"), "utf8"));
  const storiesDir = join(epicDir, "stories");
  const files = existsSync(storiesDir) ? readdirSync(storiesDir)
        .filter((file) => file.endsWith(".md"))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
  const raw = files.map((file) => ({ file, meta: frontmatter(readFileSync(join(storiesDir, file), "utf8")) }));
  const merged = new Set(raw.filter((story) => story.meta.status === "merged").map((story) => story.meta.id));
  const stories: EpicStory[] = raw.map(({ file, meta: story }) => {
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
      attempts: Number(story.attempts) || 0,
      cycles: null,
      planFile: "",
      preview: { routes: [], note: "", url: null },
      ready: status === "todo" && !blockedBy && dependsOn.every((id) => merged.has(id)),
      retryAt: null,
      loopPid: null,
      session: null,
    };
  });
  const ready = stories.find((story) => story.ready);
  return {
    epic: { id: meta.id ?? "", title: meta.title ?? "", dir: relative(root, epicDir).split(sep).join("/") },
    loop: { pid: null },
    next: ready
      ? { story: ready.id, reason: `${ready.id} is ready` }
      : { story: null, reason: stories.length === 0 ? "no stories yet" : stories.every((story) => story.status === "merged") ? "all stories merged" : "nothing ready" },
    previewEnabled: false,
    stories,
    progress: [],
    now: Date.now(),
  };
}

// The epic must sit inside the repo's .harness/initiatives, so a bad setting can't reach other files.
function resolveEpic(settings: HarnessSettings) {
  if (!settings.repo || !settings.epic) throw new Error("Pick an epic first.");
  const root = resolve(settings.repo);
  const epicDir = epicDirFor(root, settings.epic);
  if (!epicDir) throw new Error(`${settings.epic} is not an epic under .harness/initiatives.`);
  return { root, epicDir };
}

export async function loadHarnessBoard(settings: HarnessSettings) {
  if (!settings.repo || !settings.epic) {
    return { repo: "", state: null, error: null };
  }
  try {
    const { root, epicDir } = resolveEpic(settings);
    const runner = runnerFor(settings, root, epicDir);
    const raw = runner ? runner.state() : readPlan(root, epicDir);
    const state: EpicBoardState = {
      ...raw,
      repoUrl: await githubUrl(root),
      runner: Boolean(runner),
      stories: raw.stories.map((story) => ({
        ...story,
        blockedBy: story.blockedBy ?? "",
        discoveredFrom: story.discoveredFrom ?? "",
        retryAt: story.retryAt ?? null,
      })),
    };
    return { repo: settings.repo, state, error: null };
  } catch (cause) {
    return { repo: settings.repo, state: null, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export async function runHarnessAction(settings: HarnessSettings, input: { action: EpicAction; id?: string }) {
  try {
    const { root, epicDir } = resolveEpic(settings);
    const runner = runnerFor(settings, root, epicDir);
    if (!runner) throw new Error("No runner set. Add one in the harness settings to run stories.");
    const result = await runner.act(input.action, input.id);
    const ok = result.code < 300;
    return { ok, error: ok ? null : (result.body.error ?? `failed (${result.code})`), url: result.body.url ?? null };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause), url: null };
  }
}

export function stopHarnessRunner() {
  current?.runner.stop();
}

// Removes the initiative holding the active epic. Refused while the runner has anything going.
export async function deleteInitiative(settings: HarnessSettings) {
  try {
    const { root, epicDir } = resolveEpic(settings);
    const rel = relative(initiativesDir(root), epicDir);
    const slug = rel.split(sep)[0];
    if (!slug || isAbsolute(rel) || slug === "..") throw new Error("That epic is not inside an initiative.");
    const runner = runnerFor(settings, root, epicDir);
    if (runner) {
      const state = runner.state();
      const busy = state.stories.find((story) => story.loopPid !== null || story.session?.live);
      if (state.loop.pid !== null || busy) {
        throw new Error(busy ? `${busy.id} is still running. Stop it first.` : "Stop the plan first.");
      }
      runner.stop();
      runner.reset?.();
      current = null;
    }
    const target = join(initiativesDir(root), slug);
    rmSync(target, { recursive: true, force: true });
    return { ok: true, error: null, deleted: relative(root, target) };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause), deleted: null };
  }
}
