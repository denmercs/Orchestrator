import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { FactorySlice } from "../shared/factory";
import type { LoopHost } from "../shared/loop-host";
import { branchName } from "../shared/naming";
import { resolveSliceRepo } from "./factory-repo";
import { slugOf } from "./harness-layout";

export const HEARTHPLAY_E4_MISSION = "hearthplay-e4";
export const HEARTHPLAY_E5_MISSION = "hearthplay-e5-math-ladder";

// Paseo worktree folder names for Hearthplay missions (under the Hearthplay project worktree pool).
export function sliceWorktreeSlug(missionId: string, sliceId: string): string {
  if (missionId === HEARTHPLAY_E5_MISSION) return `hplay-e5-${sliceId}`;
  if (missionId === HEARTHPLAY_E4_MISSION) {
    const prefix = /^s(\d+)/.exec(sliceId);
    return prefix ? `hplay-e4-s${prefix[1]}` : `hplay-e4-${sliceId}`;
  }
  return slugOf(sliceId);
}

// True when the slice's worktree is listed under the mission repo's Paseo project with a workspace id on record.
export async function sliceWorkspaceReady(
  host: LoopHost,
  worktree: string,
  workspace: string,
  repoPath: string,
): Promise<{ ok: true; worktree: string; workspace: string } | { ok: false }> {
  const repo = resolve(repoPath);
  const listed = await host.listWorkspaces();
  const findById = workspace ? listed.find((item) => item.id === workspace) : undefined;
  const findByDir =
    worktree && existsSync(worktree) ? listed.find((item) => item.directory && resolve(item.directory) === resolve(worktree)) : undefined;
  const row = findById ?? findByDir;
  if (!row?.directory || resolve(row.projectRootPath) !== repo) return { ok: false };
  const folder = resolve(row.directory);
  if (worktree && existsSync(worktree) && folder !== resolve(worktree)) return { ok: false };
  if (workspace) {
    const refreshed = await host.refreshStoryWorkspace(workspace);
    if (refreshed?.directory && resolve(refreshed.directory) !== folder) return { ok: false };
  }
  return { ok: true, worktree: worktree && existsSync(worktree) ? worktree : folder, workspace: row.id };
}

export type EnsureSliceWorkspace =
  | { ok: true; worktree: string; workspace: string; mode: "unchanged" | "branch-off" | "adopt" }
  | { ok: false; error: string };

// Makes sure the slice has a worktree folder and a Paseo workspace under the mission repo's project. Uses branch-off when
// no checkout exists; adopts an existing folder (including one the manager made by hand) through Paseo's directory source.
export async function ensureSliceWorkspace(
  root: string,
  slice: FactorySlice,
  host: LoopHost | undefined,
  title: string,
): Promise<EnsureSliceWorkspace> {
  const { id, mission, state } = slice;
  const repo = resolveSliceRepo(root, slice);
  if (!repo.ok) return { ok: false, error: repo.error };

  const repoPath = resolve(repo.path);
  const { worktree, workspace } = state;

  const ready = await (host ? sliceWorkspaceReady(host, worktree, workspace, repoPath) : Promise.resolve({ ok: false as const }));
  if (ready.ok) return { ok: true, worktree: ready.worktree, workspace: ready.workspace, mode: "unchanged" };

  if (!host) {
    return {
      ok: false,
      error:
        worktree && existsSync(worktree)
          ? "its worktree is not a Paseo workspace and this handle can't register one"
          : "its worktree is missing and this handle can't create one",
    };
  }

  const projects = await host.listProjects();
  const project = projects.find((item) => resolve(item.projectRootPath) === repoPath);
  const projectId = project?.projectId;

  if (!worktree || !existsSync(worktree)) {
    const created = await host.createStoryWorkspace({
      title,
      repoRoot: repoPath,
      ...(projectId ? { projectId } : {}),
      baseBranch: "origin/main",
      branchName: branchName({ title: id }),
      worktreeSlug: sliceWorktreeSlug(mission, id),
    });
    return { ok: true, worktree: created.directory, workspace: created.id, mode: "branch-off" };
  }

  const adopted = await host.adoptStoryWorkspace({
    title,
    directory: worktree,
    ...(projectId ? { projectId } : {}),
  });
  return { ok: true, worktree, workspace: adopted.id, mode: "adopt" };
}