import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { FactorySlice } from "../shared/factory";
import { factoryDir } from "./factory-layout";
import { frontmatter } from "./harness-layout";

// The repo a slice's git work (workspace, worktree, base, branch, PR) belongs to. The slice's own `repo` in state.md wins, then
// its mission's `repo` in mission.md, then the factory root. A set value is an absolute or `~` path to a git repo.
export type SliceRepo = { ok: true; path: string; source: "slice" | "mission" | "root" } | { ok: false; error: string };

export const expandHome = (path: string) => (path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

// The mission's `repo` frontmatter as written ("" when absent or the mission has no file).
export function missionRepo(root: string, mission: string): string {
  const file = join(factoryDir(root), "missions", mission, "mission.md");
  return existsSync(file) ? (frontmatter(readFileSync(file, "utf8")).repo ?? "").trim() : "";
}

// The raw repo setting for a slice and where it came from; null when neither the slice nor its mission sets one.
function configured(root: string, slice: FactorySlice): { value: string; source: "slice" | "mission" } | null {
  if (slice.state.repo.trim()) return { value: slice.state.repo.trim(), source: "slice" };
  const value = missionRepo(root, slice.mission);
  return value ? { value, source: "mission" } : null;
}

// The git toplevel of `path`, or null when it is not inside a git checkout.
function gitToplevel(path: string): string | null {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return top || null;
  } catch {
    return null;
  }
}

// The validated repo for a slice's new workspace. A set `repo` that is not an absolute or `~` path to an existing git repo is an
// error, never a silent fallback to the factory root. Unset falls back to the factory root, unchecked, as before.
export function resolveSliceRepo(root: string, slice: FactorySlice): SliceRepo {
  const set = configured(root, slice);
  if (!set) return { ok: true, path: root, source: "root" };
  const where = set.source === "slice" ? `slice ${slice.id}'s state.md` : `mission ${slice.mission}'s mission.md`;
  const path = expandHome(set.value);
  if (!isAbsolute(path)) return { ok: false, error: `\`repo: ${set.value}\` in ${where} is not an absolute or ~ path.` };
  if (!existsSync(path)) return { ok: false, error: `\`repo: ${set.value}\` in ${where} does not exist.` };
  const top = gitToplevel(path);
  if (!top) return { ok: false, error: `\`repo: ${set.value}\` in ${where} is not a git repo.` };
  return { ok: true, path: top, source: set.source };
}

// Every repo folder the slices of this factory name (and the factory root): never swept or archived as a stray.
export function configuredRepoFolders(root: string, slices: FactorySlice[]): string[] {
  const folders = new Set<string>([resolve(root)]);
  for (const slice of slices) {
    const set = configured(root, slice);
    if (set) folders.add(resolve(expandHome(set.value)));
  }
  return [...folders];
}

// A lenient read for places that only need a folder to run `gh` or git in: the slice's repo when it is set and exists, else the
// factory root. It never reports an error, because the slice has already been through `resolveSliceRepo` when its workspace was made.
export function sliceRepoFolder(root: string, slice: FactorySlice): string {
  const set = configured(root, slice);
  if (!set) return root;
  const path = expandHome(set.value);
  return isAbsolute(path) && existsSync(path) ? path : root;
}
