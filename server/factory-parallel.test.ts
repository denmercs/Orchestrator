import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { FALLBACK_AGENT_CONFIG } from "../shared/agent-runner";
import { DEFAULT_LOOP_CONFIG } from "../shared/initiative-loop";
import { DEFAULT_PHASES } from "../shared/pipeline";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { TickPaseo } from "./factory-tick";
import { paseoLoopHost } from "./loop-host-paseo";

// The loop's registry lives under the home folder, so this file gets its own.
const home = mkdtempSync(join(tmpdir(), "parallel-home-"));
process.env.HOME = home;
const { createInitiativeLoop } = await import("./initiative-loop");
const { runFactoryTick } = await import("./factory-tick");
const { sliceDir } = await import("./factory-layout");

type PaseoApi = PluginHandlerContext["paseo"];
const roots: string[] = [home];
afterEach(() => {
  for (const dir of roots.splice(1)) rmSync(dir, { recursive: true, force: true });
});

const put = (file: string, text: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};
const field = (file: string, name: string) => readFileSync(file, "utf8").match(new RegExp(`^${name}: (.*)$`, "m"))?.[1];

test("a loop at its parallel cap of 1 starts nothing, and the factory still starts one agent in each of three slices", async () => {
  // Arrange: an initiative with one story in flight (the loop's one slot) and a todo story behind it.
  const root = mkdtempSync(join(tmpdir(), "parallel-"));
  roots.push(root);
  const phase = join(root, ".harness", "initiatives", "demo", "phases", "1-meter");
  put(join(root, ".harness", "initiatives", "demo", "initiative.md"), "---\nloop: on\n---\n# Initiative: Demo\n");
  put(join(phase, "phase.md"), "---\nphase: 1\ntitle: Meter\n---\n");
  const inFlight = join(phase, "stories", "01-busy.md");
  const waiting = join(phase, "stories", "02-next.md");
  put(inFlight, `---\nid: S1\ntitle: Busy\nstatus: implementing\nstep: implement\nround: 1\nworktree: ${join(root, "busy")}\nagent: busy-1\n---\n\n## Goal\n\nShip it.\n`);
  put(waiting, "---\nid: S2\ntitle: Next\nstatus: todo\n---\n\n## Goal\n\nLater.\n");
  mkdirSync(join(root, "busy", ".harness"), { recursive: true });
  put(join(root, "busy", ".harness", "state.md"), "# S1\n\n## Status\nimplement-running\n");
  put(join(home, ".orchestrator", "initiative-loops.json"), JSON.stringify([root]));

  // Arrange: three build slices with dead agents, each in its own worktree.
  put(join(root, ".harness", "factory", "project.md"), "Ship the thing.\n");
  put(join(root, ".harness", "factory", "missions", "m1", "mission.md"), "Outcome: three slices land.\n");
  const states: string[] = [];
  const trees: string[] = [];
  const known: Record<string, { status: string }> = { "busy-1": { status: "running" } };
  for (const id of ["s1", "s2", "s3"]) {
    const tree = join(root, `wt-${id}`);
    mkdirSync(tree);
    trees.push(tree);
    put(join(sliceDir(root, "m1", id), "spec.md"), `Do ${id}.\n`);
    put(join(sliceDir(root, "m1", id), "state.md"), `---\nphase: build\nrun: on\nagent: dead-${id}\nworktree: ${tree}\n---\n`);
    states.push(join(sliceDir(root, "m1", id), "state.md"));
    known[`dead-${id}`] = { status: "closed" };
  }
  const started: string[] = [];
  const loopApi = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => (known[id] ? { agent: known[id] } : null),
        timeline: { refetch: async () => ({ entries: [], error: null }) },
      }),
      list: async () => ({ entries: [{ agent: { id: "busy-1", status: "running", labels: {} } }] }),
    },
    workspaces: { ref: (workspace: string) => ({ agents: { create: async () => (started.push(workspace), { id: "loop-new" }) } }) },
  } as unknown as PaseoApi;
  const factoryPaseo: TickPaseo = {
    commit: async () => true,
    worktrees: { create: async () => ({ directory: root }) },
    agents: {
      ref: (id) => ({ refresh: async () => (known[id] ? { agent: known[id] } : null) }),
      create: async (request) => {
        const id = `seat-${request.labels.slice}`;
        known[id] = { status: "idle" };
        started.push(request.cwd);
        return { id };
      },
    },
  };
  const initiative = createInitiativeLoop(
    async () => DEFAULT_LOOP_CONFIG,
    async () => FALLBACK_AGENT_CONFIG,
    async () => ({ phases: DEFAULT_PHASES, sources: [] }),
    async () => null,
  );
  initiative.rememberHost(paseoLoopHost(loopApi));
  assert.equal(DEFAULT_LOOP_CONFIG.parallel, 1);

  // Act: the loop and the factory tick run together.
  await initiative.tick();
  const result = await runFactoryTick(root, factoryPaseo);

  // Assert: the loop held its cap (its todo story waits), yet every slice got its own agent in its own worktree.
  assert.equal(field(waiting, "status"), "todo");
  assert.equal(result.kind, "fan-out");
  assert.deepEqual([...started].sort(), [...trees].sort());
  assert.deepEqual(states.map((file) => field(file, "agent")), ["seat-s1", "seat-s2", "seat-s3"]);
});
