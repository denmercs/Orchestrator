import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { parseSliceState, type FactorySlice } from "../shared/factory";
import { fakeLoopHost } from "../test-support/fake-loop-host";
import { HEARTHPLAY_E5_MISSION, ensureSliceWorkspace, sliceWorktreeSlug, sliceWorkspaceReady } from "./factory-slice-workspace";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
const git = () => {
  const dir = tmp("repo-");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
};

test("sliceWorktreeSlug names Hearthplay E5 slices under the shared hplay-e5 prefix", () => {
  assert.equal(sliceWorktreeSlug(HEARTHPLAY_E5_MISSION, "s10-parent-report-card"), "hplay-e5-s10-parent-report-card");
  assert.equal(sliceWorktreeSlug("m1", "s10-parent-report-card"), "s10-parent-report-card");
});

test("sliceWorkspaceReady accepts a workspace listed under the mission repo", async () => {
  const repo = git();
  const manual = join(repo, "manual-wt");
  mkdirSync(manual);
  const { host, workspaces } = fakeLoopHost([]);
  host.listProjects = async () => [{ projectId: "p-hp", projectRootPath: repo }];
  workspaces.push({ id: "w1", directory: manual, projectRootPath: repo, busy: false });

  const ready = await sliceWorkspaceReady(host, manual, "w1", repo);
  assert.equal(ready.ok, true);
  if (ready.ok) {
    assert.equal(ready.workspace, "w1");
    assert.equal(ready.worktree, manual);
  }
});

test("sliceWorkspaceReady rejects a folder registered as its own standalone project", async () => {
  const repo = git();
  const manual = join(repo, "manual-wt");
  mkdirSync(manual);
  const { host, workspaces } = fakeLoopHost([]);
  host.listProjects = async () => [{ projectId: "p-hp", projectRootPath: repo }];
  workspaces.push({ id: "w-stray", directory: manual, projectRootPath: manual, busy: false });

  assert.equal((await sliceWorkspaceReady(host, manual, "", repo)).ok, false);
});

test("ensureSliceWorkspace adopts a manager-made folder under the mission repo project", async () => {
  const factoryHome = tmp("factory-");
  const product = git();
  const manual = join(product, "hplay-e5-s10-parent-report-card");
  mkdirSync(manual);
  const missionDir = join(factoryHome, ".harness", "factory", "missions", "hearthplay-e5-math-ladder", "slices", "s10-parent-report-card");
  mkdirSync(missionDir, { recursive: true });
  writeFileSync(join(factoryHome, ".harness", "factory", "missions", "hearthplay-e5-math-ladder", "mission.md"), `---\nrepo: ${product}\n---\nOutcome.\n`);
  writeFileSync(join(missionDir, "spec.md"), "Do s10.\n");
  writeFileSync(
    join(missionDir, "state.md"),
    `---\nphase: spec\nrun: on\nworktree: ${manual}\n---\n`,
  );

  const slice: FactorySlice = {
    id: "s10-parent-report-card",
    mission: HEARTHPLAY_E5_MISSION,
    state: parseSliceState({ worktree: manual, run: "on", phase: "spec" }),
    spec: "Do s10.\n",
    design: "",
    proof: "",
  };

  const { host, adopted } = fakeLoopHost([]);
  host.listProjects = async () => [{ projectId: "p-hp", projectRootPath: product }];

  const ensured = await ensureSliceWorkspace(factoryHome, slice, host, "🔁 s10");
  assert.equal(ensured.ok, true);
  if (!ensured.ok) return;
  assert.equal(ensured.mode, "adopt");
  assert.equal(ensured.worktree, manual);
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].directory, manual);
  assert.equal(adopted[0].projectId, "p-hp");

  const listed = await host.listWorkspaces();
  const row = listed.find((item) => item.id === ensured.workspace);
  assert.equal(row && resolve(row.projectRootPath), resolve(product));
});