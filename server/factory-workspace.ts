import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { FactorySlice } from "../shared/factory";
import type { LoopHost } from "../shared/loop-host";
import { factoryDir, readFactory, writeSliceState } from "./factory-layout";
import { frontmatter, writeFrontmatter } from "./harness-layout";
import { prStatus } from "./pr-checks";
import type { TickPaseo } from "./factory-tick";

// Whether the slice has ended: its PR merged, the manager's `close: on`, or ready: ci with no PR (nothing to ship, the work is on base).
async function ended(slice: FactorySlice, ports: TickPaseo): Promise<boolean> {
  const { state } = slice;
  if (state.close) return true;
  if (!state.pr) return state.ready === "ci";
  const pr = await (ports.prStatus ?? prStatus)(state.worktree, state.pr).catch(() => null);
  return pr?.state === "merged";
}

// Archives the workspace of every slice that has ended, over every slice because a `ready: ci` slice leaves the runnable set.
// A workspace with a running agent is held back and the manager is told once (`archive_held`, saved only when the steer was
// delivered, as `noteHeld` does). The repo root is never archived. A failed archive is ignored: the next pass tries again.
export async function closeSlices(root: string, ports: TickPaseo) {
  const { host, steer } = ports;
  if (!host) return;
  for (const mission of readFactory(root).missions) {
    for (const slice of mission.slices) {
      const { workspace, archived, archive_held } = slice.state;
      if (!workspace || archived) continue;
      try {
        if (!(await ended(slice, ports))) continue;
        const found = (await host.listWorkspaces()).find((item) => item.id === workspace);
        if (found && resolve(found.directory) === resolve(root)) continue;
        if (found?.busy) {
          if (archive_held) continue;
          const line = `Slice ${slice.id} is finished but an agent is still running in its workspace, so it was not archived.`;
          const delivered = steer && (await Promise.resolve().then(() => steer(line)).catch(() => false)) !== false;
          if (delivered) writeSliceState(root, mission.id, slice.id, { archive_held: true });
          continue;
        }
        await host.archiveStoryWorkspace(workspace);
        writeSliceState(root, mission.id, slice.id, { archived: true, archive_held: null });
      } catch {
        // Ignored: the slice is not blocked by a workspace that would not archive.
      }
    }
  }
}

// A project folder named like a slice worktree: `factory-sN` or `factory-<slug>`.
const factoryNamed = (folder: string) => /^factory-[a-z0-9][a-z0-9-]*$/i.test(basename(folder));

// Archives the idle workspaces whose project folder is named like a slice worktree, and returns how many were archived.
// A workspace a slice's state.md names (by `workspace` id or by `worktree` folder) and the repo root are never touched,
// and neither is a busy one. A failed archive is ignored and not counted.
export async function sweepStrayWorkspaces(root: string, host: LoopHost): Promise<number> {
  const ids = new Set<string>();
  const folders = new Set<string>([resolve(root)]);
  for (const mission of readFactory(root).missions) {
    for (const { state } of mission.slices) {
      if (state.workspace) ids.add(state.workspace);
      if (state.worktree) folders.add(resolve(state.worktree));
    }
  }
  let count = 0;
  for (const found of await host.listWorkspaces()) {
    if (found.busy || ids.has(found.id) || !factoryNamed(found.projectRootPath)) continue;
    if (folders.has(resolve(found.directory)) || folders.has(resolve(found.projectRootPath))) continue;
    try {
      await host.archiveStoryWorkspace(found.id);
      count += 1;
    } catch {
      // Ignored: a stray that would not archive stays for the next sweep.
    }
  }
  return count;
}

// The manager's one-off sweep: `sweep: on` in manager.md runs it once, clears the field and steers the count (only when a steer is wired).
export async function runRequestedSweep(root: string, ports: TickPaseo) {
  const { host, steer } = ports;
  if (!host) return;
  const file = join(factoryDir(root), "manager.md");
  if (frontmatter(existsSync(file) ? readFileSync(file, "utf8") : "").sweep !== "on") return;
  writeFrontmatter(file, { sweep: null });
  const count = await sweepStrayWorkspaces(root, host);
  await Promise.resolve().then(() => steer?.(`Swept stray slice workspaces: archived ${count}.`)).catch(() => false);
}
