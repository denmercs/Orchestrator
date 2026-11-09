import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { factoryDir, sliceDir } from "./factory-layout";
import { sweepStrayWorkspaces } from "./factory-workspace";
import { runFactoryTick, type TickPaseo } from "./factory-tick";
import type { PrStatus } from "./pr-checks";
import { fakeLoopHost } from "../test-support/fake-loop-host";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const put = (file: string, text: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};
const field = (file: string, name: string) => readFileSync(file, "utf8").match(new RegExp(`^${name}: (.*)$`, "m"))?.[1];

// A factory with one slice `s1` whose state.md is `state`, living in the workspace `ws1` (a folder under the repo).
function setup(state: string) {
  const root = mkdtempSync(join(tmpdir(), "close-"));
  roots.push(root);
  const home = join(root, ".harness", "factory");
  put(join(home, "project.md"), "Ship the thing.\n");
  put(join(home, "missions", "m1", "mission.md"), "Outcome: one slice lands.\n");
  const dir = sliceDir(root, "m1", "s1");
  put(join(dir, "spec.md"), "Add the widget.\n");
  put(join(dir, "state.md"), `---\nworkspace: ws1\n${state}\n---\n`);
  const { host, archived, workspaces } = fakeLoopHost([]);
  workspaces.push({ id: "ws1", directory: join(root, "wt"), projectRootPath: root, busy: false });
  const steers: string[] = [];
  const merged = { current: false };
  const paseo: TickPaseo = {
    host,
    steer: async (line) => {
      steers.push(line);
    },
    prStatus: async () => ({ state: merged.current ? "merged" : "pending", number: 7, url: "", headSha: "abc", failing: [] }) satisfies PrStatus,
    agents: { ref: () => ({ refresh: async () => null }), create: async () => ({ id: "unused" }) },
  };
  return { root, stateFile: join(dir, "state.md"), paseo, host, archived, workspaces, steers, merged };
}

describe("Feature: archiving a slice's workspace when the slice ends", () => {
  describe("when the slice's PR is merged", () => {
    test("archives the workspace once and records it", async () => {
      // Arrange: a shipped slice, its PR merged.
      const { root, stateFile, paseo, archived, merged } = setup("phase: ship\nkind: ship\nrun: on\npr: 7");
      merged.current = true;

      // Act: two passes.
      await runFactoryTick(root, paseo);
      await runFactoryTick(root, paseo);

      // Assert: one archive, remembered in state.md.
      assert.deepEqual(archived, ["ws1"]);
      assert.equal(field(stateFile, "archived"), "on");
    });

    test("leaves the workspace alone while the PR is still open", async () => {
      const { root, stateFile, paseo, archived } = setup("phase: ship\nkind: ship\nrun: on\npr: 7");
      await runFactoryTick(root, paseo);
      assert.deepEqual(archived, []);
      assert.equal(field(stateFile, "archived"), undefined);
    });
  });

  test("archives a scout slice once the manager writes close: on", async () => {
    const { root, stateFile, paseo, archived } = setup("phase: review\nkind: scout\nready: review\nclose: on");
    await runFactoryTick(root, paseo);
    assert.deepEqual(archived, ["ws1"]);
    assert.equal(field(stateFile, "archived"), "on");
  });

  test("keeps a scout slice's workspace until the manager closes it", async () => {
    const { root, paseo, archived } = setup("phase: review\nkind: scout\nready: review");
    await runFactoryTick(root, paseo);
    assert.deepEqual(archived, []);
  });

  test("archives a ship slice that is ready: ci with no PR, as there is nothing to ship", async () => {
    const { root, stateFile, paseo, archived } = setup("phase: ship\nkind: ship\nready: ci");
    await runFactoryTick(root, paseo);
    assert.deepEqual(archived, ["ws1"]);
    assert.equal(field(stateFile, "archived"), "on");
  });

  describe("when an agent is still running in the workspace", () => {
    test("skips the archive and steers the manager once across two passes", async () => {
      // Arrange
      const { root, stateFile, paseo, archived, workspaces, steers } = setup("phase: review\nkind: scout\nready: review\nclose: on");
      workspaces[0].busy = true;

      // Act
      await runFactoryTick(root, paseo);
      await runFactoryTick(root, paseo);

      // Assert: held, told once.
      assert.deepEqual(archived, []);
      assert.equal(steers.length, 1);
      assert.match(steers[0], /s1/);
      assert.equal(field(stateFile, "archive_held"), "on");
      assert.equal(field(stateFile, "archived"), undefined);
    });

    test("archives once the agent has finished", async () => {
      const { root, stateFile, paseo, archived, workspaces } = setup("phase: review\nkind: scout\nready: review\nclose: on");
      workspaces[0].busy = true;
      await runFactoryTick(root, paseo);
      workspaces[0].busy = false;
      await runFactoryTick(root, paseo);
      assert.deepEqual(archived, ["ws1"]);
      assert.equal(field(stateFile, "archived"), "on");
    });

    test("does not record the hold when the steer was not delivered, so the next pass tries again", async () => {
      const { root, stateFile, paseo, workspaces, steers } = setup("phase: review\nkind: scout\nready: review\nclose: on");
      workspaces[0].busy = true;
      paseo.steer = async (line) => {
        steers.push(line);
        return false;
      };
      await runFactoryTick(root, paseo);
      await runFactoryTick(root, paseo);
      assert.equal(steers.length, 2);
      assert.equal(field(stateFile, "archive_held"), undefined);
    });
  });

  test("ignores an archive that throws: the pass does not throw and the slice is not blocked", async () => {
    const { root, stateFile, paseo, host } = setup("phase: review\nkind: scout\nready: review\nclose: on");
    host.archiveStoryWorkspace = async () => {
      throw new Error("daemon down");
    };
    await runFactoryTick(root, paseo);
    assert.equal(field(stateFile, "ready"), "review");
    assert.equal(field(stateFile, "archived"), undefined);
  });

  test("never archives the repo root, even when the slice names it", async () => {
    const { root, stateFile, paseo, archived, workspaces } = setup("phase: review\nkind: scout\nready: review\nclose: on");
    workspaces[0].directory = root;
    await runFactoryTick(root, paseo);
    assert.deepEqual(archived, []);
    assert.equal(field(stateFile, "archived"), undefined);
  });
});

describe("Feature: sweeping stray slice workspaces", () => {
  const stray = (id: string, root: string, name: string, busy = false) => ({ id, directory: join(root, "elsewhere", id), projectRootPath: join(root, "..", name), busy });

  test("archives an idle factory-s8 workspace and leaves the rest alone", async () => {
    // Arrange: slice s1 owns ws1 (by id) and a checkout at `owned` (by worktree); the others are strays or not.
    const { root, host, archived, workspaces } = setup("phase: build\nkind: ship\nworktree: " + join(tmpdir(), "owned"));
    workspaces.splice(
      0,
      workspaces.length,
      { id: "ws1", directory: join(root, "wt"), projectRootPath: join(root, "..", "factory-s1"), busy: false },
      { id: "wsOwned", directory: join(tmpdir(), "owned"), projectRootPath: join(tmpdir(), "owned"), busy: false },
      stray("wsStray", root, "factory-s8"),
      stray("wsSlug", root, "factory-fancy-slug"),
      stray("wsBusy", root, "factory-s9", true),
      stray("wsOther", root, "my-app"),
      { id: "wsRoot", directory: root, projectRootPath: join(root, "..", "factory-s2"), busy: false },
    );

    // Act
    const count = await sweepStrayWorkspaces(root, host);

    // Assert: only the idle factory-named strays are archived.
    assert.deepEqual(archived.sort(), ["wsSlug", "wsStray"]);
    assert.equal(count, 2);
  });

  test("ignores a failed archive and counts only the ones that went through", async () => {
    const { root, host, archived, workspaces } = setup("phase: build\nkind: ship");
    workspaces.splice(0, workspaces.length, stray("a", root, "factory-s8"), stray("b", root, "factory-s9"));
    host.archiveStoryWorkspace = async (id) => {
      if (id === "a") throw new Error("down");
      archived.push(id);
    };
    assert.equal(await sweepStrayWorkspaces(root, host), 1);
    assert.deepEqual(archived, ["b"]);
  });

  describe("when the manager writes sweep: on", () => {
    test("runs the sweep once, clears the field and steers the count", async () => {
      const { root, paseo, archived, workspaces, steers } = setup("phase: build\nkind: ship");
      workspaces.push(stray("wsStray", root, "factory-s8"));
      const manager = join(factoryDir(root), "manager.md");
      put(manager, "---\nagent: mgr1\nsweep: on\n---\n");

      await runFactoryTick(root, paseo);
      await runFactoryTick(root, paseo);

      assert.deepEqual(archived, ["wsStray"]);
      assert.equal(field(manager, "sweep"), undefined);
      assert.equal(field(manager, "agent"), "mgr1");
      assert.equal(steers.length, 1);
      assert.match(steers[0], /1/);
    });

    test("does not sweep without sweep: on", async () => {
      const { root, paseo, archived, workspaces } = setup("phase: build\nkind: ship");
      workspaces.push(stray("wsStray", root, "factory-s8"));
      put(join(factoryDir(root), "manager.md"), "---\nagent: mgr1\n---\n");
      await runFactoryTick(root, paseo);
      assert.deepEqual(archived, []);
    });
  });
});
