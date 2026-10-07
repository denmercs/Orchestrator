import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EpicBoardState } from "../shared/orchestration";
import { renderPlanFor } from "./phase-plan";
import {
  PHASE_FILE,
  epicDirFor,
  frontmatter,
  initiativeLoopState,
  initiativeTitle,
  initiativeTracker,
  initiativesDir,
  readStories,
  refreshInitiativeIndex,
} from "./harness-layout";

// The board reads the active phase straight from the layout in server/harness-layout.ts: its
// stories (file order is priority), its architecture plan, and its initiative's tracker.

export type HarnessSettings = { repo: string; epic: string };

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

// The phase must sit inside the repo's .harness/initiatives, so a bad setting can't reach other files.
function resolvePhase(settings: HarnessSettings) {
  if (!settings.repo || !settings.epic) throw new Error("Pick a phase first.");
  const root = resolve(settings.repo);
  const epicDir = epicDirFor(root, settings.epic);
  if (!epicDir) throw new Error(`${settings.epic} is not a phase under .harness/initiatives.`);
  return { root, epicDir };
}

export async function loadHarnessBoard(settings: HarnessSettings) {
  if (!settings.repo || !settings.epic) {
    return { repo: "", state: null, error: null };
  }
  try {
    const { root, epicDir } = resolvePhase(settings);
    const meta = frontmatter(readFileSync(join(epicDir, PHASE_FILE), "utf8"));
    const stories = readStories(epicDir);
    const ready = stories.find((story) => story.ready);
    const slug = relative(initiativesDir(root), epicDir).split(sep)[0];
    const initiativeDir = join(initiativesDir(root), slug);
    // Keep initiative.md's phases-and-stories list current as sessions add and move stories.
    refreshInitiativeIndex(initiativeDir);
    const state: EpicBoardState = {
      epic: { id: meta.phase ?? "", title: meta.title ?? "", dir: relative(root, epicDir).split(sep).join("/") },
      initiative: initiativeTitle(initiativeDir),
      initiativeSlug: slug,
      loop: initiativeLoopState(initiativeDir),
      tracker: initiativeTracker(initiativeDir),
      plan: renderPlanFor(settings),
      next: ready
        ? { story: ready.id, reason: `${ready.id} is ready` }
        : {
            story: null,
            reason:
              stories.length === 0
                ? "no stories yet"
                : stories.every((story) => story.status === "merged")
                  ? "all stories merged"
                  : "nothing ready",
          },
      repoUrl: await githubUrl(root),
      stories,
    };
    return { repo: settings.repo, state, error: null };
  } catch (cause) {
    return { repo: settings.repo, state: null, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

// Removes the initiative holding the active phase, with every phase in it.
export async function deleteInitiative(settings: HarnessSettings) {
  try {
    const { root, epicDir } = resolvePhase(settings);
    const rel = relative(initiativesDir(root), epicDir);
    const slug = rel.split(sep)[0];
    if (!slug || isAbsolute(rel) || slug === "..") throw new Error("That phase is not inside an initiative.");
    const target = join(initiativesDir(root), slug);
    rmSync(target, { recursive: true, force: true });
    return { ok: true, error: null, deleted: relative(root, target) };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause), deleted: null };
  }
}
