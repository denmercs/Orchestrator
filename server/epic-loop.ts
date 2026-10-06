import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { EpicAction, EpicBoardState } from "../shared/orchestration";

// The epic board reads and drives skillsync's epic-loop through the same module its web
// dashboard uses (tools/lib/epic-dashboard.cjs), so the two never disagree about a story.

type ActResult = { code: number; body: { error?: string; url?: string | null } };
type EpicActions = {
  previews: { stopAll(): void };
  state(): Omit<EpicBoardState, "repoUrl"> & Record<string, unknown>;
  act(action: string, id?: string): Promise<ActResult>;
};
type EpicDashboardLib = {
  epicDashboardOptions(root: string): Record<string, unknown>;
  createEpicActions(opts: Record<string, unknown>): EpicActions;
};

const DEFAULT_SKILLSYNC = join(homedir(), "Desktop", "Personal", "skillsync");
const LIB = join("tools", "lib", "epic-dashboard.cjs");

let current: { key: string; actions: EpicActions; repoUrl: string } | null = null;

function skillsyncDirFor(repo: string, configured: string) {
  const candidates = [configured, join(repo, ".cursor", "vendor", "skillsync"), process.env.SKILLSYNC_DIR ?? "", DEFAULT_SKILLSYNC];
  const found = candidates.filter(Boolean).map((dir) => resolve(dir)).find((dir) => existsSync(join(dir, LIB)));
  if (!found) {
    throw new Error(`No skillsync with ${LIB} found. Set the skillsync folder in the epic board settings.`);
  }
  return found;
}

function githubUrl(repo: string): Promise<string> {
  return new Promise((done) => {
    execFile("gh", ["repo", "view", "--json", "url", "-q", ".url"], { cwd: repo, timeout: 15_000 }, (error, stdout) => {
      done(error ? "" : stdout.trim());
    });
  });
}

async function actionsFor(repo: string, skillsyncDir: string) {
  const dir = skillsyncDirFor(repo, skillsyncDir);
  const key = `${resolve(repo)}\n${dir}`;
  if (current?.key !== key) {
    current?.actions.previews.stopAll();
    const lib = createRequire(join(dir, LIB))(join(dir, LIB)) as EpicDashboardLib;
    const actions = lib.createEpicActions(lib.epicDashboardOptions(resolve(repo)));
    current = { key, actions, repoUrl: await githubUrl(repo) };
  }
  return current;
}

export async function loadEpicBoard(settings: { repo: string; skillsyncDir: string }) {
  if (!settings.repo) {
    return { repo: "", state: null, error: null };
  }
  try {
    const { actions, repoUrl } = await actionsFor(settings.repo, settings.skillsyncDir);
    const raw = actions.state();
    const state: EpicBoardState = {
      epic: raw.epic,
      loop: raw.loop,
      next: raw.next,
      previewEnabled: raw.previewEnabled,
      repoUrl,
      stories: raw.stories.map((story) => ({
        ...story,
        blockedBy: story.blockedBy ?? "",
        discoveredFrom: story.discoveredFrom ?? "",
        retryAt: story.retryAt ?? null,
      })),
      progress: raw.progress,
      now: raw.now,
    };
    return { repo: settings.repo, state, error: null };
  } catch (cause) {
    return { repo: settings.repo, state: null, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export async function runEpicLoopAction(
  settings: { repo: string; skillsyncDir: string },
  input: { action: EpicAction; id?: string },
) {
  try {
    if (!settings.repo) {
      throw new Error("Set the epic repo first.");
    }
    const { actions } = await actionsFor(settings.repo, settings.skillsyncDir);
    const result = await actions.act(input.action, input.id);
    const ok = result.code < 300;
    return { ok, error: ok ? null : (result.body.error ?? `failed (${result.code})`), url: result.body.url ?? null };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause), url: null };
  }
}

export function stopEpicPreviews() {
  current?.actions.previews.stopAll();
}
