import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { FALLBACK_AGENT_CONFIG, type AgentProfile } from "../shared/agent-runner";
import { branchName } from "../shared/naming";
import { DEFAULT_PHASES } from "../shared/pipeline";
import { runnableSlices } from "../shared/factory";
import { namedStories, readFactory, sliceDir, storyKey, writeSliceState } from "./factory-layout";
import { MANAGER_MODELS, steerManager, type ManagerPaseo } from "./factory-manager";
import { buildContext, runFactoryTick, type TickPaseo } from "./factory-tick";
import { writeFrontmatter } from "./harness-layout";
import { APPROVE_MESSAGE } from "./gate-actions";
import { createInitiativeLoop } from "./initiative-loop";
import { DEFAULT_LOOP_CONFIG } from "../shared/initiative-loop";
import type { PrStatus } from "./pr-checks";
import { RESTART_LINE } from "./story-steps";
import type { StoryWorkspaceCreate } from "../shared/loop-host";
import { fakeLoopHost } from "../test-support/fake-loop-host";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const put = (file: string, text: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};

// A factory with one slice in `build`; `state` is its state.md frontmatter beyond the worktree.
function setup(state: string, run = "on", phase = "build") {
  const root = mkdtempSync(join(tmpdir(), "tick-"));
  roots.push(root);
  const worktree = join(root, "wt");
  mkdirSync(worktree);
  const home = join(root, ".harness", "factory");
  put(join(home, "project.md"), "Ship the thing.\n");
  put(join(home, "missions", "m1", "mission.md"), "Outcome: one slice lands.\n");
  const dir = sliceDir(root, "m1", "s1");
  put(join(dir, "spec.md"), "Add the widget.\n");
  put(join(dir, "state.md"), `---\nphase: ${phase}\nrun: ${run}\nworktree: ${worktree}\n${state}\n---\n`);
  return { root, worktree, stateFile: join(dir, "state.md") };
}

type Known = Record<string, { status: string; archivedAt?: string | null; lastUsage?: { totalCostUsd?: number } | null }>;
// `stale` is a per-id queue of reads served before the real one: a snapshot, `null` (an empty answer) or an Error (a read that throws).
// `list` is the daemon's agent list; absent, the port has none.
type Reads = { stale?: Record<string, ({ status: string; archivedAt?: string | null } | null | Error)[]>; list?: { id: string; status: string; archivedAt?: string | null }[] };

function fakePaseo(known: Known = {}, { stale = {}, list }: Reads = {}) {
  const created: { cwd: string; prompt: string; title: string; labels: Record<string, string>; config: unknown }[] = [];
  const commits: { cwd: string; message: string }[] = [];
  // The loop's host: a workspace create lands in <repoRoot>/made-wt, and the repo is a known project.
  const { host, workspaces } = fakeLoopHost([]);
  const worktrees: StoryWorkspaceCreate[] = [];
  const makeWorkspace = host.createStoryWorkspace;
  const projects = [{ projectId: "proj-other", projectRootPath: "/elsewhere" }];
  host.listProjects = async () => projects;
  const started: { workspace: string; title: string; labels: Record<string, string> }[] = [];
  const startOnHost = host.startStepAgent;
  host.startStepAgent = async (workspace, input) => {
    started.push({ workspace, title: input.title, labels: input.labels });
    return startOnHost(workspace, input);
  };
  host.createStoryWorkspace = async (input) => {
    worktrees.push(input);
    const made = await makeWorkspace(input);
    const directory = join(input.repoRoot, "made-wt");
    mkdirSync(directory, { recursive: true });
    return { id: made.id, directory };
  };
  const paseo: TickPaseo = {
    host,
    steps: {
      api: {} as NonNullable<TickPaseo["steps"]>["api"],
      readPipeline: async () => ({ phases: DEFAULT_PHASES, sources: [] }),
      readAgentConfig: async () => FALLBACK_AGENT_CONFIG,
    },
    commit: async (cwd, message) => {
      commits.push({ cwd, message });
      return true;
    },
    agents: {
      ref: (id) => ({
        refresh: async () => {
          const read = stale[id]?.length ? stale[id].shift() : undefined;
          if (read instanceof Error) throw read;
          if (read !== undefined) return read ? { agent: read } : null;
          return known[id] ? { agent: known[id] } : null;
        },
      }),
      create: async (request) => {
        created.push({ cwd: request.cwd, prompt: request.prompt, title: request.title, labels: request.labels, config: request.config });
        await new Promise((resolve) => setImmediate(resolve));
        const id = `new-${created.length}`;
        known[id] = { status: "idle" };
        return { id };
      },
    },
  };
  if (list) paseo.agents.list = async () => ({ entries: list.map((agent) => ({ agent })) });
  return { paseo, created, started, worktrees, commits, workspaces, projects };
}

const field = (file: string, name: string) => readFileSync(file, "utf8").match(new RegExp(`^${name}: (.*)$`, "m"))?.[1];

test("a spec slice with an empty spec waits and changes nothing", async () => {
  const { root, stateFile } = setup("", "on", "spec");
  writeFileSync(join(sliceDir(root, "m1", "s1"), "spec.md"), "\n");
  const { paseo, created } = fakePaseo();
  const result = await runFactoryTick(root, paseo);
  assert.equal(result.kind, "waiting");
  assert.equal(field(stateFile, "phase"), "spec");
  assert.equal(created.length, 0);
});

test("a written spec with design off goes to build and creates no design seat", async () => {
  const { root, stateFile } = setup("", "on", "spec");
  const { paseo, created } = fakePaseo();
  assert.deepEqual(await runFactoryTick(root, paseo), { kind: "advanced", slice: "s1", phase: "build" });
  assert.equal(field(stateFile, "phase"), "build");
  assert.equal(created.length, 0);
});

test("a written spec with design on goes to design", async () => {
  const { root, stateFile } = setup("design: on", "on", "spec");
  const { paseo, created } = fakePaseo();
  assert.deepEqual(await runFactoryTick(root, paseo), { kind: "advanced", slice: "s1", phase: "design" });
  assert.equal(field(stateFile, "phase"), "design");
  assert.equal(created.length, 0);
});

test("a spec slice with no worktree gets a workspace from the host, found through the repo's project", async () => {
  // Arrange: no worktree on record, and the repo is one of the host's projects.
  const { root, worktree, stateFile } = setup("", "on", "spec");
  rmSync(worktree, { recursive: true });
  const { paseo, worktrees, workspaces, projects } = fakePaseo();
  projects.push({ projectId: "proj-repo", projectRootPath: root });

  // Act
  assert.equal((await runFactoryTick(root, paseo)).kind, "advanced");

  // Assert: one create, off origin/main in the repo's project; the slice records the workspace and its folder.
  assert.equal(worktrees.length, 1);
  assert.equal(worktrees[0].repoRoot, root);
  assert.equal(worktrees[0].projectId, "proj-repo");
  assert.equal(worktrees[0].baseBranch, "origin/main");
  assert.match(worktrees[0].branchName, /s1/);
  assert.equal(field(stateFile, "workspace"), workspaces[0].id);
  assert.equal(field(stateFile, "worktree"), join(root, "made-wt"));
  assert.equal(field(stateFile, "phase"), "build");
  // The story file made in that folder carries the workspace too.
  assert.equal(field(field(stateFile, "story")!, "workspace"), workspaces[0].id);
});

test("a spec slice with no story gets <worktree>/.harness/story.md written from its spec", async () => {
  const { root, worktree, stateFile } = setup("", "on", "spec");
  const { paseo, worktrees } = fakePaseo();
  await runFactoryTick(root, paseo);
  const story = join(worktree, ".harness", "story.md");
  assert.equal(worktrees.length, 0);
  assert.equal(field(stateFile, "story"), story);
  assert.match(readFileSync(story, "utf8"), /Add the widget\./);
});

test("a spec slice that already has a story keeps it", async () => {
  const { root, stateFile } = setup("", "on", "spec");
  const story = join(root, "story.md");
  put(story, "---\nstatus: todo\n---\nMine.\n");
  writeFileSync(stateFile, readFileSync(stateFile, "utf8").replace("run: on", `run: on\nstory: ${story}`));
  await runFactoryTick(root, fakePaseo().paseo);
  assert.equal(field(stateFile, "story"), story);
  assert.match(readFileSync(story, "utf8"), /Mine\.\n$/);
  assert.equal(field(stateFile, "phase"), "build");
});

const writeDesign = (root: string, text: string) => writeFileSync(join(sliceDir(root, "m1", "s1"), "design.md"), text);

test("a design slice waits while design.md is empty, whether its seat is idle or mid-turn", async () => {
  for (const status of ["idle", "running", "initializing"]) {
    const { root, stateFile } = setup("agent: d-1", "on", "design");
    writeDesign(root, "\n");
    const { paseo, created } = fakePaseo({ "d-1": { status } });
    assert.deepEqual(await runFactoryTick(root, paseo), { kind: "alive", slice: "s1", agent: "d-1" });
    assert.equal(field(stateFile, "phase"), "design");
    assert.equal(created.length, 0);
  }
});

test("a design slice waits while its seat is mid-turn, even with design.md written", async () => {
  for (const status of ["running", "initializing"]) {
    const { root, stateFile } = setup("agent: d-1", "on", "design");
    writeDesign(root, "Use a queue.\n");
    const { paseo } = fakePaseo({ "d-1": { status } });
    assert.equal((await runFactoryTick(root, paseo)).kind, "alive");
    assert.equal(field(stateFile, "phase"), "design");
  }
});

test("a design slice goes to build once design.md is written and the turn has ended", async () => {
  const { root, stateFile } = setup("agent: d-1", "on", "design");
  writeDesign(root, "Use a queue.\n");
  const { paseo, created } = fakePaseo({ "d-1": { status: "idle" } });
  assert.deepEqual(await runFactoryTick(root, paseo), { kind: "advanced", slice: "s1", phase: "build" });
  assert.equal(field(stateFile, "phase"), "build");
  assert.equal(field(stateFile, "agent"), undefined);
  assert.equal(field(stateFile, "seat"), undefined);
  assert.equal(created.length, 0);
});

test("after design the live design agent is not read as the builder, even when the handle can't run steps", async () => {
  const { root, stateFile } = setup("agent: d-1\nseat: design", "on", "design");
  writeDesign(root, "Use a queue.\n");
  const { paseo, created } = fakePaseo({ "d-1": { status: "idle" } });
  delete paseo.steps;
  await runFactoryTick(root, paseo);
  assert.deepEqual(await runFactoryTick(root, paseo), { kind: "restarted", slice: "s1", agent: "new-1" });
  assert.equal(created.length, 1);
  assert.equal(field(stateFile, "seat"), "builder");
});

test("the builder's story context carries the design, and none when there isn't one", () => {
  const { root } = setup("", "on", "build");
  writeDesign(root, "Use a queue.\n");
  const slice = readFactory(root).missions[0].slices[0];
  const ctx = buildContext(slice);
  assert.match(ctx.body, /Add the widget\./);
  assert.match(ctx.body, /Design/);
  assert.match(ctx.body, /Use a queue\./);
  assert.doesNotMatch(buildContext({ ...slice, design: "" }).body, /Design/);
});

test("a slice without run: on stays idle", async () => {
  const { root } = setup("agent: dead-1", "off");
  const { paseo, created } = fakePaseo();
  assert.deepEqual(await runFactoryTick(root, paseo), { kind: "idle" });
  assert.equal(created.length, 0);
});

test("a missing factory is an idle tick", async () => {
  const root = mkdtempSync(join(tmpdir(), "tick-"));
  roots.push(root);
  assert.deepEqual(await runFactoryTick(root, fakePaseo().paseo), { kind: "idle" });
});

test("a build slice whose agent is dead gets one builder in its worktree, with the spec and refocus", async () => {
  const { root, worktree, stateFile } = setup("agent: dead-1\nattempt: 1");
  const { paseo, created } = fakePaseo({ "dead-1": { status: "error" } });
  const result = await runFactoryTick(root, paseo);
  assert.deepEqual(result, { kind: "restarted", slice: "s1", agent: "new-1" });
  assert.equal(created.length, 1);
  assert.equal(created[0].cwd, worktree);
  assert.match(created[0].prompt, /Add the widget\./);
  assert.match(created[0].prompt, /Outcome: one slice lands\./);
  assert.match(created[0].prompt, /Ship the thing\./);
  assert.match(created[0].prompt, /still serve/);
  const state = readFileSync(stateFile, "utf8");
  assert.match(state, /agent: new-1/);
  assert.match(state, /attempt: 2/);
  assert.match(state, /seat: builder/);
});

test("a live agent is left alone, whatever it is doing", async () => {
  for (const status of ["idle", "running", "initializing"]) {
    const { root } = setup("agent: live-1");
    const { paseo, created } = fakePaseo({ "live-1": { status } });
    assert.deepEqual(await runFactoryTick(root, paseo), { kind: "alive", slice: "s1", agent: "live-1" });
    assert.equal(created.length, 0);
  }
});

test("a live agent whose first read is empty is left alone once the second read finds it", async () => {
  const { root } = setup("agent: live-1");
  const { paseo, created } = fakePaseo({ "live-1": { status: "idle" } }, { stale: { "live-1": [null] } });
  assert.deepEqual(await runFactoryTick(root, paseo), { kind: "alive", slice: "s1", agent: "live-1" });
  assert.equal(created.length, 0);
});

test("a first read that is dead and a second that throws waits for the next tick", async () => {
  const { root } = setup("agent: live-1");
  const { paseo, created } = fakePaseo({ "live-1": { status: "idle" } }, { stale: { "live-1": [null, new Error("daemon down")] } });
  assert.deepEqual(await runFactoryTick(root, paseo), { kind: "alive", slice: "s1", agent: "live-1" });
  assert.equal(created.length, 0);
});

test("an agent both reads call dead but the agent list shows running is left alone", async () => {
  const { root } = setup("agent: live-1");
  const { paseo, created } = fakePaseo({}, { list: [{ id: "live-1", status: "running" }] });
  assert.deepEqual(await runFactoryTick(root, paseo), { kind: "alive", slice: "s1", agent: "live-1" });
  assert.equal(created.length, 0);
});

test("an agent both reads call dead is replaced when the agent list has it archived or not at all", async () => {
  for (const list of [[{ id: "live-1", status: "idle", archivedAt: "2026-11-01" }], [{ id: "other", status: "running" }]]) {
    const { root } = setup("agent: live-1");
    const { paseo, created } = fakePaseo({}, { list });
    assert.deepEqual(await runFactoryTick(root, paseo), { kind: "restarted", slice: "s1", agent: "new-1" });
    assert.equal(created.length, 1);
  }
});

test("an archived or missing agent is replaced", async () => {
  const gone: Record<string, { status: string; archivedAt?: string }>[] = [{ "a-1": { status: "idle", archivedAt: "2026-11-01" } }, { other: { status: "idle" } }];
  for (const known of gone) {
    const { root } = setup("agent: a-1");
    const { paseo, created } = fakePaseo(known);
    assert.equal((await runFactoryTick(root, paseo)).kind, "restarted");
    assert.equal(created.length, 1);
  }
});

test("two ticks at once give a dead builder exactly one replacement", async () => {
  const { root } = setup("agent: dead-1");
  const { paseo, created } = fakePaseo({ "dead-1": { status: "closed" } });
  await Promise.all([runFactoryTick(root, paseo), runFactoryTick(root, paseo)]);
  await runFactoryTick(root, paseo);
  assert.equal(created.length, 1);
});

test("the tick leaves a story the loop's live session still supervises", async () => {
  const { root } = setup("agent: dead-1\nstory: STORY");
  const story = join(root, "story.md");
  put(story, "---\nstatus: implementing\nagent: loop-1\n---\n");
  const stateFile = join(sliceDir(root, "m1", "s1"), "state.md");
  writeFileSync(stateFile, readFileSync(stateFile, "utf8").replace("STORY", story));
  const { paseo, created } = fakePaseo({ "dead-1": { status: "error" }, "loop-1": { status: "running" } });
  assert.equal((await runFactoryTick(root, paseo)).kind, "waiting");
  assert.equal(created.length, 0);
});

test("a loop session whose first read is empty still supervises its story, in seat supervision and in build", async () => {
  for (const steps of [false, true]) {
    const { root } = setup("agent: dead-1\nstory: STORY");
    const story = join(root, "story.md");
    put(story, "---\nstatus: implementing\nagent: loop-1\n---\n");
    const stateFile = join(sliceDir(root, "m1", "s1"), "state.md");
    writeFileSync(stateFile, readFileSync(stateFile, "utf8").replace("STORY", story));
    const { paseo, created } = fakePaseo({ "dead-1": { status: "error" }, "loop-1": { status: "running" } }, { stale: { "loop-1": [null] } });
    if (!steps) delete paseo.steps;
    assert.equal((await runFactoryTick(root, paseo)).kind, "waiting");
    assert.equal(created.length, 0);
  }
});

test("namedStories lists the story files slices name, so the loop skips them", () => {
  const { root } = setup("story: /x/y/story.md");
  assert.deepEqual([...namedStories(root)], ["/x/y/story.md"]);
});

test("namedStories matches relative and symlinked story paths under any root", () => {
  const { root } = setup("story: stories/story.md");
  const real = join(root, "stories", "story.md");
  put(real, "---\nstatus: todo\n---\n");
  const link = join(mkdtempSync(join(tmpdir(), "link-")), "story.md");
  symlinkSync(real, link);
  const named = namedStories(root);
  assert.ok(named.has(storyKey(real)));
  assert.ok(named.has(storyKey(link)));
  assert.ok(named.has(storyKey("stories/story.md", root)));
  assert.ok(!named.has(storyKey("stories/story.md", tmpdir())));
});

// A build slice's story file and the worktree's state.md, as the loop steps leave them.
function withStory(ctx: { root: string; worktree: string; stateFile: string }, story: string, marker: string, extra = "", file = join(ctx.root, "story.md")) {
  put(file, `---\ntitle: Widget\nstatus: todo\n${story}\n---\n\nAdd the widget.\n`);
  put(join(ctx.worktree, ".harness", "state.md"), `# S\n\n## Status\n${marker}\n${extra}`);
  writeFileSync(ctx.stateFile, readFileSync(ctx.stateFile, "utf8").replace("---\n", `---\nstory: ${file}\n`));
  return file;
}
const sliceLabels = (step: string, round = "1") => ({
  kind: "factory-seat",
  seat: "builder",
  "factory-slice": "s1",
  "factory-mission": "m1",
  "loop-initiative": "m1",
  "loop-story": "s1",
  "loop-step": step,
  "loop-round": round,
});
const cycles = (...done: boolean[]) => `\n## Cycles\n${done.map((d, i) => `- [${d ? "x" : " "}] Cycle ${i + 1} — part ${i + 1}`).join("\n")}\n`;

test("entering build launches Plan in the worktree with the slice's labels and records the agent", async () => {
  const ctx = setup("");
  const story = withStory(ctx, "", "todo");
  const { paseo, created } = fakePaseo();
  assert.deepEqual(await runFactoryTick(ctx.root, paseo), { kind: "restarted", slice: "s1", agent: "new-1" });
  assert.equal(created.length, 1);
  assert.equal(created[0].cwd, ctx.worktree);
  assert.deepEqual(created[0].labels, sliceLabels("plan"));
  assert.match(created[0].prompt, /Add the widget\./);
  assert.equal(field(story, "step"), "plan");
  assert.equal(field(story, "agent"), "new-1");
  assert.equal(field(ctx.stateFile, "agent"), "new-1");
  assert.equal(field(ctx.stateFile, "phase"), "build");
});

// A story file with the loop's own id and title, named by slice s1.
function namedStory(ctx: { root: string; stateFile: string }, extra = "") {
  const file = join(ctx.root, "story.md");
  put(file, `---\nid: S8\ntitle: Factory start paths\nstatus: todo\n${extra}---\n\nAdd the widget.\n`);
  writeFileSync(ctx.stateFile, readFileSync(ctx.stateFile, "utf8").replace("---\n", `---\nstory: ${file}\n`));
}

describe("loop-style names", () => {
  test("a slice naming a story titles its Plan session, workspace and QA seat from the story's id and title", async () => {
    // Arrange: build slice naming the story.
    const build = setup("");
    namedStory(build);
    put(join(build.worktree, ".harness", "state.md"), "# S\n\n## Status\ntodo\n");
    const planned = fakePaseo();

    // Act + Assert: Plan carries the loop's title.
    await runFactoryTick(build.root, planned.paseo);
    assert.equal(planned.created[0].title, "🔁 S8 · Plan — Factory start paths");

    // Arrange: spec slice with no workspace yet.
    const spec = setup("", "on", "spec");
    rmSync(spec.worktree, { recursive: true });
    namedStory(spec);
    const made = fakePaseo();
    made.projects.push({ projectId: "proj-repo", projectRootPath: spec.root });

    // Act + Assert: the fresh workspace is titled from the story, the branch still from the slice id.
    await runFactoryTick(spec.root, made.paseo);
    assert.equal(made.worktrees[0].title, "🔁 S8 — Factory start paths");
    assert.equal(made.worktrees[0].branchName, branchName({ title: "s1" }));

    // Arrange: test slice with no QA agent yet.
    const qaCtx = setup("", "on", "test");
    namedStory(qaCtx, "step: implement\nround: 1\nagent: i-1\nstatus: implementing\n");
    put(join(qaCtx.worktree, ".harness", "state.md"), "# S\n\n## Status\nimplement-done\n" + cycles(true));
    const qa = fakePaseo({ "i-1": { status: "idle" } });

    // Act + Assert: the QA seat is titled like a loop Test step.
    await runFactoryTick(qaCtx.root, qa.paseo);
    assert.equal(qa.created[0].labels.seat, "qa");
    assert.equal(qa.created[0].title, "🔁 S8 · Test — Factory start paths");
  });

  test("a slice with no story keeps its slice id in the workspace and QA seat titles", async () => {
    const spec = setup("", "on", "spec");
    rmSync(spec.worktree, { recursive: true });
    const made = fakePaseo();
    made.projects.push({ projectId: "proj-repo", projectRootPath: spec.root });
    await runFactoryTick(spec.root, made.paseo);
    assert.equal(made.worktrees[0].title, "🔁 s1");

    const { ctx } = testSlice("implement-done", "");
    const qa = fakePaseo({ "i-1": { status: "idle" } });
    await runFactoryTick(ctx.root, qa.paseo);
    assert.match(qa.created[0].title, /^🔁 s1 · Test/);
  });
});

test("a slice whose story lives in an initiative is labelled with that initiative and the story's id", async () => {
  const ctx = setup("");
  withStory(ctx, "id: S7", "todo", "", join(ctx.root, ".harness", "initiatives", "init-a", "phases", "1-x", "stories", "01-y.md"));
  const { paseo, created } = fakePaseo();
  await runFactoryTick(ctx.root, paseo);
  assert.equal(created[0].labels["loop-initiative"], "init-a");
  assert.equal(created[0].labels["loop-story"], "S7");
});

test("a slice whose initiative story has no id is labelled with the mission and the slice", async () => {
  const ctx = setup("");
  withStory(ctx, "", "todo", "", join(ctx.root, ".harness", "initiatives", "init-a", "phases", "1-x", "stories", "01-y.md"));
  const { paseo, created } = fakePaseo();
  await runFactoryTick(ctx.root, paseo);
  assert.equal(created[0].labels["loop-initiative"], "m1");
  assert.equal(created[0].labels["loop-story"], "s1");
});

test("a diagnose-track story starts with Diagnose, not Plan", async () => {
  const ctx = setup("");
  withStory(ctx, "track: diagnose", "todo");
  const { paseo, created } = fakePaseo();
  await runFactoryTick(ctx.root, paseo);
  assert.equal(created.length, 1);
  assert.equal(created[0].labels["loop-step"], "diagnose");
});

test("plan-done with the planner's turn ended launches Implement round 1", async () => {
  const ctx = setup("agent: p-1");
  const story = withStory(ctx, "step: plan\nround: 1\nagent: p-1\nstatus: planning", "plan-done", cycles(false));
  const { paseo, created } = fakePaseo({ "p-1": { status: "idle" } });
  assert.deepEqual(await runFactoryTick(ctx.root, paseo), { kind: "restarted", slice: "s1", agent: "new-1" });
  assert.deepEqual(created[0].labels, { ...sliceLabels("implement"), "loop-cycles": "subagents" });
  assert.equal(field(story, "step"), "implement");
  assert.equal(field(ctx.stateFile, "phase"), "build");
});

test("plan-done moves nothing while the planner is still mid-turn", async () => {
  for (const status of ["running", "initializing"]) {
    const ctx = setup("agent: p-1");
    const story = withStory(ctx, "step: plan\nround: 1\nagent: p-1\nstatus: planning", "plan-done", cycles(false));
    const { paseo, created } = fakePaseo({ "p-1": { status } });
    assert.equal((await runFactoryTick(ctx.root, paseo)).kind, "alive");
    assert.equal(created.length, 0);
    assert.equal(field(story, "step"), "plan");
  }
});

test("implement-done commits the work and moves the slice to test", async () => {
  const ctx = setup("agent: i-1");
  withStory(ctx, "step: implement\nround: 1\nagent: i-1\nstatus: implementing", "implement-done", cycles(true));
  const { paseo, created, commits } = fakePaseo({ "i-1": { status: "idle" } });
  assert.deepEqual(await runFactoryTick(ctx.root, paseo), { kind: "advanced", slice: "s1", phase: "test" });
  assert.equal(commits.length, 1);
  assert.equal(commits[0].cwd, ctx.worktree);
  assert.equal(field(ctx.stateFile, "phase"), "test");
  assert.equal(created.length, 0);
});

describe("Implement as one parent with subagents", () => {
  test("a plan-done slice with three open cycles starts one parent session for all of them", async () => {
    const ctx = setup("agent: p-1");
    const story = withStory(ctx, "step: plan\nround: 1\nagent: p-1\nstatus: planning", "plan-done", cycles(false, false, false));
    const { paseo, created } = fakePaseo({ "p-1": { status: "idle" } });
    const result = await runFactoryTick(ctx.root, paseo);
    assert.equal(result.kind, "restarted");
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].labels, { ...sliceLabels("implement"), "loop-cycles": "subagents" });
    assert.equal(field(story, "cycles"), "subagents");
    assert.equal(field(ctx.stateFile, "agent"), "new-1");
  });

  test("a pass while the parent runs with cycles ticked keeps its agent, starts nothing and does not block", async () => {
    const ctx = setup("agent: i-1");
    withStory(ctx, "step: implement\nround: 1\ncycles: subagents\nagent: i-1\nstatus: implementing", "implement-running", cycles(true, true, false));
    const { paseo, created, commits } = fakePaseo({ "i-1": { status: "running" } });
    assert.equal((await runFactoryTick(ctx.root, paseo)).kind, "alive");
    assert.equal(created.length, 0);
    assert.equal(commits.length, 0);
    assert.equal(field(ctx.stateFile, "agent"), "i-1");
    assert.equal(field(ctx.stateFile, "ready"), undefined);
  });

  test("the parent's implement-done commits once and moves to test, without a second session", async () => {
    const ctx = setup("agent: i-1");
    withStory(ctx, "step: implement\nround: 1\ncycles: subagents\nagent: i-1\nstatus: implementing", "implement-done", cycles(true, true, true));
    const { paseo, created, commits } = fakePaseo({ "i-1": { status: "idle" } });
    assert.deepEqual(await runFactoryTick(ctx.root, paseo), { kind: "advanced", slice: "s1", phase: "test" });
    assert.equal((await runFactoryTick(ctx.root, paseo)).kind !== "advanced", true);
    assert.equal(commits.length, 1);
    assert.equal(created.filter((spec) => spec.labels["loop-step"] === "implement").length, 0);
  });

  test("a parent that says implement-done with a cycle unticked waits and commits nothing", async () => {
    const ctx = setup("agent: i-1");
    withStory(ctx, "step: implement\nround: 1\ncycles: subagents\nagent: i-1\nstatus: implementing", "implement-done", cycles(true, false, true));
    const { paseo, commits } = fakePaseo({ "i-1": { status: "idle" } });
    assert.equal((await runFactoryTick(ctx.root, paseo)).kind, "waiting");
    assert.equal(commits.length, 0);
  });

  test("a dead parent restarts as a parent with only the cycles still open", async () => {
    const ctx = setup("agent: i-1");
    const story = withStory(ctx, "step: implement\nround: 1\ncycles: subagents\nagent: i-1\nstatus: implementing", "implement-running", cycles(true, false, false));
    const { paseo, created } = fakePaseo({ "i-1": { status: "error" } });
    assert.equal((await runFactoryTick(ctx.root, paseo)).kind, "restarted");
    assert.equal(created.length, 1);
    assert.equal(created[0].labels["loop-cycles"], "subagents");
    assert.match(created[0].prompt, /Cycle 2/);
    assert.match(created[0].prompt, /Cycle 3/);
    assert.doesNotMatch(created[0].prompt, /Cycle 1 — part 1/);
    assert.equal(field(story, "cycles"), "subagents");
  });
});

test("implement-done with a cycle still open commits and launches the next Implement cycle", async () => {
  const ctx = setup("agent: i-1");
  const story = withStory(ctx, "step: implement\nround: 1\ncycle: 1\nagent: i-1\nstatus: implementing", "implement-done", cycles(true, false));
  const { paseo, created, commits } = fakePaseo({ "i-1": { status: "idle" } });
  assert.equal((await runFactoryTick(ctx.root, paseo)).kind, "restarted");
  assert.equal(commits.length, 1);
  assert.equal(field(ctx.stateFile, "phase"), "build");
  assert.equal(field(story, "cycle"), "2");
  assert.equal(created[0].labels["loop-step"], "implement");
});

test("implement-done stays in build while the builder is mid-turn, and when its cycle was never ticked", async () => {
  const running = setup("agent: i-1");
  withStory(running, "step: implement\nround: 1\nagent: i-1\nstatus: implementing", "implement-done", cycles(true));
  const a = fakePaseo({ "i-1": { status: "running" } });
  assert.equal((await runFactoryTick(running.root, a.paseo)).kind, "alive");
  assert.equal(a.commits.length, 0);
  assert.equal(field(running.stateFile, "phase"), "build");

  const unticked = setup("agent: i-1");
  withStory(unticked, "step: implement\nround: 1\ncycle: 1\nagent: i-1\nstatus: implementing", "implement-done", cycles(false));
  const b = fakePaseo({ "i-1": { status: "idle" } });
  assert.equal((await runFactoryTick(unticked.root, b.paseo)).kind, "waiting");
  assert.equal(b.commits.length, 0);
  assert.equal(field(unticked.stateFile, "phase"), "build");
});

test("a dead build agent is relaunched on its current step with RESTART_LINE and the refocus", async () => {
  const ctx = setup("agent: i-1\nattempt: 1");
  const story = withStory(ctx, "step: implement\nround: 2\nagent: i-1\nstatus: implementing", "implement-running", cycles(false));
  const { paseo, created } = fakePaseo({ "i-1": { status: "error" } });
  assert.deepEqual(await runFactoryTick(ctx.root, paseo), { kind: "restarted", slice: "s1", agent: "new-1" });
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].labels, sliceLabels("implement", "2"));
  assert.ok(created[0].prompt.includes(RESTART_LINE));
  assert.match(created[0].prompt, /Outcome: one slice lands\./);
  assert.match(created[0].prompt, /Ship the thing\./);
  assert.match(created[0].prompt, /still serve/);
  assert.equal(field(story, "agent"), "new-1");
  assert.equal(field(ctx.stateFile, "attempt"), "2");
});

test("a build agent that reads error once and idle on the second read is not relaunched", async () => {
  const ctx = setup("agent: i-1\nattempt: 1");
  withStory(ctx, "step: implement\nround: 2\nagent: i-1\nstatus: implementing", "implement-running", cycles(false));
  const { paseo, created } = fakePaseo({ "i-1": { status: "idle" } }, { stale: { "i-1": [{ status: "error" }] } });
  assert.deepEqual(await runFactoryTick(ctx.root, paseo), { kind: "alive", slice: "s1", agent: "i-1" });
  assert.equal(created.length, 0);
  assert.equal(field(ctx.stateFile, "attempt"), "1");
});

// Adoption: the manager names a story already in flight on a slice that is still in `spec`. `withStory` seeds `status: todo`, so
// a story that brings its own status has that line dropped.
function adoptedStory(ctx: Parameters<typeof withStory>[0], story: string, marker: string, extra = "") {
  const file = withStory(ctx, story, marker, extra);
  if (/^status:/m.test(story)) writeFileSync(file, readFileSync(file, "utf8").replace("status: todo\n", ""));
  return file;
}
test("an adopted in-flight story with a dead agent maps to build, then the tick relaunches it once and never twice", async () => {
  const ctx = setup("agent: i-1\nattempt: 1", "on", "spec");
  const story = adoptedStory(ctx, "step: implement\nround: 2\nagent: i-1\nstatus: implementing", "implement-running", cycles(false));
  const known: Record<string, { status: string }> = { "i-1": { status: "error" } };
  const { paseo, created } = fakePaseo(known);
  assert.deepEqual(await runFactoryTick(ctx.root, paseo), { kind: "advanced", slice: "s1", phase: "build" });
  assert.equal(field(ctx.stateFile, "phase"), "build");
  assert.equal(created.length, 0);
  assert.equal(field(story, "status"), "implementing");
  assert.deepEqual(await runFactoryTick(ctx.root, paseo), { kind: "restarted", slice: "s1", agent: "new-1" });
  assert.deepEqual(created[0].labels, sliceLabels("implement", "2"));
  assert.ok(created[0].prompt.includes(RESTART_LINE));
  assert.equal((await runFactoryTick(ctx.root, paseo)).kind, "alive");
  assert.equal(created.length, 1);
});

test("an adopted story's step picks the phase: reviewing goes to review, pr-open to ship keeping the slice's pr, and plan to build", async () => {
  const phaseOf = async (story: string, state = "") => {
    const ctx = setup(state, "on", "spec");
    adoptedStory(ctx, story, "todo");
    const { paseo, created } = fakePaseo();
    const result = await runFactoryTick(ctx.root, paseo);
    assert.equal(created.length, 0);
    return { result, phase: field(ctx.stateFile, "phase"), pr: field(ctx.stateFile, "pr") };
  };
  assert.deepEqual(await phaseOf("step: review\nround: 1\nstatus: reviewing"), { result: { kind: "advanced", slice: "s1", phase: "review" }, phase: "review", pr: undefined });
  assert.equal((await phaseOf("step: plan\nround: 1\nstatus: planning")).phase, "build");
  assert.equal((await phaseOf("step: diagnose\nround: 1\nstatus: planning")).phase, "build");
  assert.deepEqual(await phaseOf("step: pr-open\npr: 12", "pr: 7"), { result: { kind: "advanced", slice: "s1", phase: "ship" }, phase: "ship", pr: "7" });
  assert.deepEqual(await phaseOf("step: pr\nstatus: pr-open\npr: 12"), { result: { kind: "advanced", slice: "s1", phase: "ship" }, phase: "ship", pr: "12" });
});

test("a named story with no step falls through to the normal spec handling", async () => {
  const ctx = setup("", "on", "spec");
  withStory(ctx, "", "todo");
  const { paseo } = fakePaseo();
  assert.deepEqual(await runFactoryTick(ctx.root, paseo), { kind: "advanced", slice: "s1", phase: "build" });
});

test("a build story with no step marker and a live idle agent is left alone", async () => {
  const ctx = setup("agent: i-1");
  withStory(ctx, "step: implement\nround: 1\nagent: i-1\nstatus: implementing", "implement-running", cycles(false));
  const { paseo, created, commits } = fakePaseo({ "i-1": { status: "idle" } });
  assert.equal((await runFactoryTick(ctx.root, paseo)).kind, "alive");
  assert.equal(created.length + commits.length, 0);
});

// A plan turn that ended without plan-done, with a live idle planner, and the manager steers and approvals the tick sends.
function planGate(extra = "") {
  const ctx = setup(`agent: p-1\n${extra}`);
  const story = withStory(ctx, "step: plan\nround: 1\nagent: p-1\nstatus: planning", "plan-running", cycles(false));
  // withStory seeds `status: todo`; drop it so the story has the one status the gate rewrites.
  writeFileSync(story, readFileSync(story, "utf8").replace("status: todo\n", ""));
  const known = { "p-1": { status: "idle" } };
  const fake = fakePaseo(known);
  const steers: string[] = [];
  const sent: { agent: string; text: string }[] = [];
  fake.paseo.steer = async (line) => void steers.push(line);
  // The approval wakes the planner, as it does for real.
  fake.paseo.send = async (agent, text) => {
    sent.push({ agent, text });
    known["p-1"].status = "running";
  };
  return { ctx, story, fake, steers, sent };
}

test("a plan turn that ends without plan-done sets awaiting-approval and steers the manager once over three passes", async () => {
  const { ctx, story, fake, steers, sent } = planGate();
  for (let pass = 0; pass < 3; pass++) assert.equal((await runFactoryTick(ctx.root, fake.paseo)).kind, "waiting");
  assert.equal(field(story, "status"), "awaiting-approval");
  assert.equal(steers.length, 1);
  assert.match(steers[0], /s1/);
  assert.equal(fake.created.length + sent.length, 0);
});

test("approve: plan sends APPROVE_MESSAGE to the planner once, clears the field and puts the story back to planning", async () => {
  const { ctx, story, fake, steers, sent } = planGate();
  await runFactoryTick(ctx.root, fake.paseo);
  writeFileSync(ctx.stateFile, readFileSync(ctx.stateFile, "utf8").replace("---\n", "---\napprove: plan\n"));
  await runFactoryTick(ctx.root, fake.paseo);
  await runFactoryTick(ctx.root, fake.paseo);
  assert.deepEqual(sent, [{ agent: "p-1", text: APPROVE_MESSAGE }]);
  assert.equal(field(ctx.stateFile, "approve"), undefined);
  assert.equal(field(story, "status"), "planning");
  assert.equal(steers.length, 1);
});

test("an awaiting-approval plan without approve: plan sends nothing to the planner", async () => {
  const { ctx, fake, sent } = planGate();
  await runFactoryTick(ctx.root, fake.paseo);
  await runFactoryTick(ctx.root, fake.paseo);
  assert.equal(sent.length, 0);
});

// A story the loop already parked as awaiting-approval, adopted by a slice with no manager yet: the steer goes through the real
// `steerManager` over fake agents, which creates the manager on the way.
function parkedPlan(steerResult: () => boolean = () => true) {
  const ctx = setup("agent: p-1", "on", "spec");
  const story = adoptedStory(ctx, "step: plan\nround: 1\nagent: p-1\nstatus: awaiting-approval", "plan-running", cycles(false));
  const known: Record<string, { status: string }> = { "p-1": { status: "idle" } };
  const fake = fakePaseo(known);
  const managerSent: { id: string; text: string }[] = [];
  const managerCreated: string[] = [];
  const managerPaseo: ManagerPaseo = {
    agents: {
      ref: (id) => ({
        refresh: async () => (known[id] ? { agent: known[id] } : null),
        send: async (text) => {
          managerSent.push({ id, text });
          return undefined;
        },
      }),
      create: async () => {
        const id = `mgr-${managerCreated.length + 1}`;
        managerCreated.push(id);
        known[id] = { status: "idle" };
        return { id };
      },
    },
  };
  fake.paseo.steer = async (line) => {
    const delivered = await steerManager(ctx.root, line, managerPaseo);
    return delivered && steerResult();
  };
  return { ctx, story, fake, managerSent, managerCreated };
}
const managerFile = (root: string) => join(root, ".harness", "factory", "manager.md");

test("a parked awaiting-approval story with no manager steers once through steerManager, creating the manager and recording steered: plan", async () => {
  const { ctx, fake, managerSent, managerCreated } = parkedPlan();
  for (let pass = 0; pass < 3; pass++) await runFactoryTick(ctx.root, fake.paseo);
  // The first pass adopts the story and the next ones reach the gate: one manager, one steer, remembered on the slice.
  assert.deepEqual(managerCreated, ["mgr-1"]);
  assert.equal(managerSent.length, 1);
  assert.match(managerSent[0].text, /s1/);
  assert.equal(managerSent[0].id, "mgr-1");
  assert.match(readFileSync(managerFile(ctx.root), "utf8"), /agent: mgr-1/);
  assert.equal(field(ctx.stateFile, "steered"), "plan");
});

test("a plan-gate steer that is not delivered records nothing, so the next pass tries again", async () => {
  let deliver = false;
  const { ctx, fake, managerSent } = parkedPlan(() => deliver);
  for (let pass = 0; pass < 3; pass++) await runFactoryTick(ctx.root, fake.paseo);
  assert.equal(field(ctx.stateFile, "steered"), undefined);
  const attempts = managerSent.length;
  assert.ok(attempts >= 2);
  deliver = true;
  await runFactoryTick(ctx.root, fake.paseo);
  assert.equal(field(ctx.stateFile, "steered"), "plan");
  await runFactoryTick(ctx.root, fake.paseo);
  assert.equal(managerSent.length, attempts + 1);
});

test("approving a plan clears steered, so a later plan gate steers again", async () => {
  const { ctx, story, fake, managerSent } = parkedPlan();
  for (let pass = 0; pass < 3; pass++) await runFactoryTick(ctx.root, fake.paseo);
  assert.equal(field(ctx.stateFile, "steered"), "plan");
  fake.paseo.send = async () => undefined;
  writeFileSync(ctx.stateFile, readFileSync(ctx.stateFile, "utf8").replace("---\n", "---\napprove: plan\n"));
  await runFactoryTick(ctx.root, fake.paseo);
  assert.equal(field(ctx.stateFile, "steered"), undefined);
  assert.equal(field(story, "status"), "planning");
  assert.equal(managerSent.length, 1);
});

// A slice in `test`, as the build left it: the story still says implementing, with the idle builder's agent on it.
// The QA seat (`q-1` when `qa` is set) writes its verdict on the worktree's `## Status`.
function testSlice(verdict: string, qa = "q-1") {
  const ctx = setup(qa ? `agent: ${qa}
seat: qa` : "", "on", "test");
  const story = withStory(ctx, "step: implement\nround: 1\nagent: i-1\nstatus: implementing", verdict, cycles(true));
  writeFileSync(join(sliceDir(ctx.root, "m1", "s1"), "spec.md"), "Add the widget.\n\nChecks: `npm test` passes and the widget renders.\n");
  return { ctx, story };
}
const writeProof = (root: string, text: string) => writeFileSync(join(sliceDir(root, "m1", "s1"), "proof.md"), text);

test("entering test starts the QA seat on the manager models, with the spec's checks and where to write its verdict", async () => {
  const { ctx } = testSlice("implement-done", "");
  const { paseo, created } = fakePaseo({ "i-1": { status: "idle" } });
  assert.equal((await runFactoryTick(ctx.root, paseo)).kind, "restarted");
  assert.equal(created.length, 1);
  assert.equal(created[0].labels.seat, "qa");
  assert.deepEqual(created[0].config, MANAGER_MODELS[0]);
  assert.match(created[0].prompt, /npm test` passes and the widget renders/);
  assert.match(created[0].prompt, /proof\.md/);
  assert.match(created[0].prompt, /\.harness\/state\.md/);
  assert.match(created[0].prompt, /test-done/);
  assert.match(created[0].prompt, /test-failed/);
  assert.equal(field(ctx.stateFile, "seat"), "qa");
  assert.equal(field(ctx.stateFile, "agent"), "new-1");
});

test("test-done with a filled proof.md and a finished turn moves the slice to review", async () => {
  const { ctx } = testSlice("test-done");
  writeProof(ctx.root, "All checks pass.\n");
  const { paseo, created } = fakePaseo({ "q-1": { status: "idle" } });
  assert.deepEqual(await runFactoryTick(ctx.root, paseo), { kind: "advanced", slice: "s1", phase: "review" });
  assert.equal(field(ctx.stateFile, "phase"), "review");
  assert.equal(created.length, 0);
});

test("test-done waits while proof.md is empty or the QA seat is mid-turn", async () => {
  const empty = testSlice("test-done");
  writeProof(empty.ctx.root, "\n");
  const a = fakePaseo({ "q-1": { status: "idle" } });
  assert.equal((await runFactoryTick(empty.ctx.root, a.paseo)).kind, "waiting");
  assert.equal(field(empty.ctx.stateFile, "phase"), "test");

  const running = testSlice("test-done");
  writeProof(running.ctx.root, "All checks pass.\n");
  const b = fakePaseo({ "q-1": { status: "running" } });
  assert.equal((await runFactoryTick(running.ctx.root, b.paseo)).kind, "alive");
  assert.equal(field(running.ctx.stateFile, "phase"), "test");
});

test("no verdict leaves the QA seat to finish", async () => {
  const { ctx } = testSlice("implement-done");
  writeProof(ctx.root, "All checks pass.\n");
  const { paseo, created } = fakePaseo({ "q-1": { status: "idle" } });
  assert.deepEqual(await runFactoryTick(ctx.root, paseo), { kind: "alive", slice: "s1", agent: "q-1" });
  assert.equal(field(ctx.stateFile, "phase"), "test");
  assert.equal(created.length, 0);
});

test("test-failed goes back to build as Implement round 2 with the failing checks in its prompt, never fix", async () => {
  const { ctx, story } = testSlice("test-failed\nwidget renders blank\nnpm test: 2 failing");
  const { paseo, created } = fakePaseo({ "q-1": { status: "idle" }, "i-1": { status: "idle" } });
  assert.deepEqual(await runFactoryTick(ctx.root, paseo), { kind: "restarted", slice: "s1", agent: "new-1" });
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].labels, sliceLabels("implement", "2"));
  assert.match(created[0].prompt, /widget renders blank/);
  assert.match(created[0].prompt, /npm test: 2 failing/);
  assert.equal(field(story, "step"), "implement");
  assert.equal(field(story, "round"), "2");
  assert.equal(field(ctx.stateFile, "phase"), "build");
  assert.equal(field(ctx.stateFile, "seat"), "builder");
});

test("test-failed waits while the QA seat is mid-turn", async () => {
  const { ctx } = testSlice("test-failed\nwidget renders blank");
  const { paseo, created } = fakePaseo({ "q-1": { status: "running" } });
  assert.equal((await runFactoryTick(ctx.root, paseo)).kind, "alive");
  assert.equal(created.length, 0);
  assert.equal(field(ctx.stateFile, "phase"), "test");
});

// A slice in `review`. Entering: the QA seat is gone and the story still says implement. Otherwise the reviewer (`r-1`) is
// on it, and `findings` is what sits under `## Review findings` when it wrote its marker.
function reviewSlice(marker: string, { kind = "ship", entering = false, round = 1, reviewRound = 0, findings = "" } = {}) {
  const ctx = setup(`kind: ${kind}${entering ? "" : "\nagent: r-1\nseat: reviewer"}`, "on", "review");
  const story = entering
    ? withStory(ctx, `step: implement\nround: ${round}\nagent: i-1\nstatus: implementing`, marker, cycles(true))
    : withStory(ctx, `step: review\nround: ${round}\nagent: r-1\nstatus: reviewing${reviewRound ? `\nreview_round: ${reviewRound}` : ""}`, marker, `${cycles(true)}\n## Review findings\n${findings}\n`);
  return { ctx, story };
}
const OPEN = "- [ ] blocking: server/x.ts:1 — wrong — fix it";

test("entering review launches the loop's Review step with the slice's labels, as the reviewer", async () => {
  const { ctx, story } = reviewSlice("test-done", { entering: true });
  const { paseo, created } = fakePaseo({ "i-1": { status: "idle" } });
  assert.deepEqual(await runFactoryTick(ctx.root, paseo), { kind: "restarted", slice: "s1", agent: "new-1" });
  assert.equal(created.length, 1);
  assert.equal(created[0].cwd, ctx.worktree);
  assert.deepEqual(created[0].labels, { ...sliceLabels("review"), seat: "reviewer" });
  assert.equal(field(story, "step"), "review");
  assert.equal(field(story, "round"), "1");
  assert.equal(field(ctx.stateFile, "phase"), "review");
  assert.equal(field(ctx.stateFile, "seat"), "reviewer");
  assert.equal(field(ctx.stateFile, "agent"), "new-1");
});

test("a review with open findings goes back to build as Implement round 2", async () => {
  const { ctx, story } = reviewSlice("review-done", { findings: OPEN });
  const { paseo, created } = fakePaseo({ "r-1": { status: "idle" } });
  assert.deepEqual(await runFactoryTick(ctx.root, paseo), { kind: "restarted", slice: "s1", agent: "new-1" });
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].labels, sliceLabels("implement", "2"));
  assert.equal(field(story, "step"), "implement");
  assert.equal(field(story, "round"), "2");
  assert.equal(field(ctx.stateFile, "phase"), "build");
  assert.equal(field(ctx.stateFile, "seat"), "builder");
});

test("a clean review on a scout slice steers once over repeated passes, sets ready: review and opens no PR", async () => {
  const { ctx } = reviewSlice("review-done", { kind: "scout", findings: "- [x] blocking: server/x.ts:1 — wrong — fixed" });
  const { paseo, created, commits } = fakePaseo({ "r-1": { status: "idle" } });
  const steers: string[] = [];
  paseo.steer = async (line) => void steers.push(line);
  const ship = shipPorts(paseo, null);
  for (let pass = 0; pass < 3; pass++) await runFactoryTick(ctx.root, paseo);
  assert.equal(steers.length, 1);
  assert.equal(ship.opened.length, 0);
  assert.match(steers[0], /s1/);
  assert.equal(field(ctx.stateFile, "ready"), "review");
  assert.equal(field(ctx.stateFile, "phase"), "review");
  assert.equal(field(ctx.stateFile, "pr"), undefined);
  assert.equal(created.length + commits.length, 0);
});

test("a clean review on a ship slice goes to ship, with no steer and no seat", async () => {
  const { ctx } = reviewSlice("review-done", { findings: "- [x] blocking: server/x.ts:1 — wrong — fixed" });
  const { paseo, created } = fakePaseo({ "r-1": { status: "idle" } });
  const steers: string[] = [];
  paseo.steer = async (line) => void steers.push(line);
  assert.deepEqual(await runFactoryTick(ctx.root, paseo), { kind: "advanced", slice: "s1", phase: "ship" });
  assert.equal(field(ctx.stateFile, "phase"), "ship");
  assert.equal(field(ctx.stateFile, "ready"), undefined);
  assert.equal(created.length + steers.length, 0);
});

test("a review waits while the reviewer is mid-turn or has written no marker", async () => {
  for (const [marker, status] of [["review-done", "running"], ["review-running", "idle"]]) {
    const { ctx } = reviewSlice(marker, { findings: OPEN });
    const { paseo, created } = fakePaseo({ "r-1": { status } });
    assert.equal((await runFactoryTick(ctx.root, paseo)).kind, "alive");
    assert.equal(field(ctx.stateFile, "phase"), "review");
    assert.equal(created.length, 0);
  }
});

test("a review still blocking at the round limit waits and moves nothing", async () => {
  const { ctx } = reviewSlice("review-done", { reviewRound: 3, findings: OPEN });
  const { paseo, created } = fakePaseo({ "r-1": { status: "idle" } });
  const result = await runFactoryTick(ctx.root, paseo);
  assert.equal(result.kind, "waiting");
  assert.match((result as { why: string }).why, /blocking/);
  assert.equal(field(ctx.stateFile, "phase"), "review");
  assert.equal(created.length, 0);
});

test("a dead reviewer is relaunched on Review in the same round with RESTART_LINE", async () => {
  const { ctx } = reviewSlice("review-running", { round: 2 });
  const { paseo, created } = fakePaseo({ "r-1": { status: "error" } });
  assert.equal((await runFactoryTick(ctx.root, paseo)).kind, "restarted");
  assert.deepEqual(created[0].labels, { ...sliceLabels("review", "2"), seat: "reviewer" });
  assert.ok(created[0].prompt.includes(RESTART_LINE));
});

test("a reviewer that reads error once and idle on the second read is not relaunched", async () => {
  const { ctx } = reviewSlice("review-running", { round: 2 });
  const { paseo, created } = fakePaseo({ "r-1": { status: "idle" } }, { stale: { "r-1": [{ status: "error" }] } });
  assert.deepEqual(await runFactoryTick(ctx.root, paseo), { kind: "alive", slice: "s1", agent: "r-1" });
  assert.equal(created.length, 0);
});

test("a restart of an Implement round after test-failed still lists the failing checks", async () => {
  const { ctx } = testSlice("test-failed\nwidget renders blank");
  const known: Record<string, { status: string }> = { "q-1": { status: "idle" }, "i-1": { status: "idle" } };
  const { paseo, created } = fakePaseo(known);
  await runFactoryTick(ctx.root, paseo);
  known["new-1"].status = "error";
  await runFactoryTick(ctx.root, paseo);
  assert.equal(created.length, 2);
  assert.ok(created[1].prompt.includes(RESTART_LINE));
  assert.match(created[1].prompt, /widget renders blank/);
});

// Fakes for the ship phase's git and gh ports. `pr.current` is what `prStatus` reports; the spies record every call.
function shipPorts(paseo: TickPaseo, current: PrStatus | null, opened: { number: number; url: string } | null = { number: 7, url: "https://example.test/pr/7" }) {
  const pr = { current };
  const spies = {
    opened: [] as { cwd: string; input: { id: string; branch: string; base: string; jira: boolean } }[],
    pushed: [] as { cwd: string; message: string }[],
    reports: [] as string[],
  };
  paseo.openPr = async (cwd, input) => {
    spies.opened.push({ cwd, input });
    return opened;
  };
  paseo.prStatus = async () => pr.current;
  paseo.failureReport = async (_cwd, failing) => {
    spies.reports.push(failing.map((check) => check.name).join(","));
    return `- ${failing.map((check) => check.name).join("\n- ")}\nlog: the widget test failed`;
  };
  paseo.push = async (cwd, message) => void spies.pushed.push({ cwd, message });
  return { ...spies, pr };
}
const prAt = (state: PrStatus["state"], headSha = "abc", failing: PrStatus["failing"] = []): PrStatus => ({ state, number: 7, url: "https://example.test/pr/7", headSha, failing });
const FAILED = [{ name: "ci / test", url: "https://example.test/run/1", runId: "1" }];

// A slice in `ship`: the reviewer is done and gone. With `pr` the PR is already open and `story` adds to the story's frontmatter.
function shipSlice({ pr = "", story = "", marker = "review-done" } = {}) {
  const ctx = setup(`kind: ship${pr ? `\npr: ${pr}` : ""}`, "on", "ship");
  const file = withStory(ctx, `step: review\nround: 1\nstatus: ${pr ? "pr-open" : "reviewing"}${story ? `\n${story}` : ""}`, marker, `${cycles(true)}\n## Review findings\n- [x] blocking: server/x.ts:1 — wrong — fixed\n`);
  return { ctx, story: file };
}

test("entering ship opens the PR once over repeated passes and records it on the slice", async () => {
  const { ctx, story } = shipSlice();
  const { paseo, created } = fakePaseo();
  const ship = shipPorts(paseo, prAt("pending"));
  for (let pass = 0; pass < 3; pass++) await runFactoryTick(ctx.root, paseo);
  assert.equal(ship.opened.length, 1);
  assert.equal(ship.opened[0].cwd, ctx.worktree);
  assert.equal(ship.opened[0].input.id, "s1");
  assert.match(ship.opened[0].input.branch, /s1/);
  assert.equal(ship.opened[0].input.base, "origin/main");
  assert.equal(field(ctx.stateFile, "pr"), "7");
  assert.equal(field(story, "status"), "pr-open");
  assert.equal(field(ctx.stateFile, "phase"), "ship");
  assert.equal(created.length, 0);
});

test("a PR that can't be opened waits and records no pr", async () => {
  const { ctx } = shipSlice();
  const { paseo } = fakePaseo();
  const ship = shipPorts(paseo, null);
  paseo.openPr = async () => {
    throw new Error("push rejected");
  };
  const result = await runFactoryTick(ctx.root, paseo);
  assert.equal(result.kind, "waiting");
  assert.match((result as { why: string }).why, /push rejected/);
  assert.equal(field(ctx.stateFile, "pr"), undefined);
  assert.equal(ship.pushed.length, 0);
});

test("failing CI launches the Fix step once per failing head, with the failure report, as the builder", async () => {
  const { ctx, story } = shipSlice({ pr: "7" });
  const { paseo, created } = fakePaseo();
  const ship = shipPorts(paseo, prAt("failing", "abc", FAILED));
  for (let pass = 0; pass < 3; pass++) await runFactoryTick(ctx.root, paseo);
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].labels, sliceLabels("fix"));
  assert.match(created[0].prompt, /ci \/ test/);
  assert.match(created[0].prompt, /the widget test failed/);
  assert.equal(field(story, "fixed_sha"), "abc");
  assert.equal(field(story, "fix_attempts"), "1");
  assert.equal(field(ctx.stateFile, "agent"), "new-1");
  assert.equal(field(ctx.stateFile, "phase"), "ship");
  assert.equal(ship.opened.length, 0);
});

test("a new failing head after a pushed fix launches Fix again, and the attempts limit stops it with one steer", async () => {
  const { ctx, story } = shipSlice({ pr: "7", story: "fixed_sha: abc\nfix_attempts: 2" });
  put(join(ctx.worktree, ".orchestrator", "pipeline.json"), JSON.stringify({ maxFixes: 2 }));
  const { paseo, created } = fakePaseo();
  const steers: string[] = [];
  paseo.steer = async (line) => void steers.push(line);
  shipPorts(paseo, prAt("failing", "def", FAILED));
  for (let pass = 0; pass < 3; pass++) await runFactoryTick(ctx.root, paseo);
  assert.equal(created.length, 0);
  assert.equal(steers.length, 1);
  assert.match(steers[0], /still failing/);
  assert.equal(field(ctx.stateFile, "ready"), "ci");
  assert.equal(field(story, "fix_attempts"), "2");
});

test("fix-done pushes the fix once and goes back to watching", async () => {
  const { ctx } = shipSlice({ pr: "7", story: "agent: f-1\nfixed_sha: abc\nfix_attempts: 1", marker: "fix-done\nFix the widget test" });
  writeFileSync(ctx.stateFile, readFileSync(ctx.stateFile, "utf8").replace("---\n", "---\nagent: f-1\n"));
  const { paseo, created } = fakePaseo({ "f-1": { status: "idle" } });
  // CI still reports the old head until GitHub sees the push.
  const ship = shipPorts(paseo, prAt("failing", "abc", FAILED));
  for (let pass = 0; pass < 3; pass++) await runFactoryTick(ctx.root, paseo);
  assert.equal(ship.pushed.length, 1);
  assert.equal(ship.pushed[0].cwd, ctx.worktree);
  assert.match(ship.pushed[0].message, /Fix the widget test/);
  assert.equal(created.length, 0);
  assert.equal(field(ctx.stateFile, "agent"), undefined);
  // The new head fails too: the next Fix is attempt 2.
  ship.pr.current = prAt("failing", "def", FAILED);
  await runFactoryTick(ctx.root, paseo);
  assert.equal(created.length, 1);
  assert.equal(ship.pushed.length, 1);
});

test("a running Fix agent is left alone, and a dead one is relaunched with RESTART_LINE", async () => {
  const running = shipSlice({ pr: "7", story: "agent: f-1\nfixed_sha: abc\nfix_attempts: 1", marker: "fix-running" });
  writeFileSync(running.ctx.stateFile, readFileSync(running.ctx.stateFile, "utf8").replace("---\n", "---\nagent: f-1\n"));
  const a = fakePaseo({ "f-1": { status: "running" } });
  const shipA = shipPorts(a.paseo, prAt("failing", "abc", FAILED));
  assert.equal((await runFactoryTick(running.ctx.root, a.paseo)).kind, "alive");
  assert.equal(a.created.length + shipA.pushed.length, 0);

  const dead = shipSlice({ pr: "7", story: "agent: f-1\nfixed_sha: abc\nfix_attempts: 1", marker: "fix-running" });
  writeFileSync(dead.ctx.stateFile, readFileSync(dead.ctx.stateFile, "utf8").replace("---\n", "---\nagent: f-1\n"));
  const b = fakePaseo({ "f-1": { status: "error" } });
  shipPorts(b.paseo, prAt("failing", "abc", FAILED));
  assert.equal((await runFactoryTick(dead.ctx.root, b.paseo)).kind, "restarted");
  assert.deepEqual(b.created[0].labels, sliceLabels("fix"));
  assert.ok(b.created[0].prompt.includes(RESTART_LINE));

  const stale = shipSlice({ pr: "7", story: "agent: f-1\nfixed_sha: abc\nfix_attempts: 1", marker: "fix-running" });
  writeFileSync(stale.ctx.stateFile, readFileSync(stale.ctx.stateFile, "utf8").replace("---\n", "---\nagent: f-1\n"));
  const c = fakePaseo({ "f-1": { status: "idle" } }, { stale: { "f-1": [{ status: "error" }] } });
  shipPorts(c.paseo, prAt("failing", "abc", FAILED));
  assert.equal((await runFactoryTick(stale.ctx.root, c.paseo)).kind, "waiting");
  assert.equal(c.created.length, 0);
});

test("pending CI waits and nothing is sent", async () => {
  const { ctx } = shipSlice({ pr: "7" });
  const { paseo, created } = fakePaseo();
  const steers: string[] = [];
  paseo.steer = async (line) => void steers.push(line);
  const ship = shipPorts(paseo, prAt("pending"));
  assert.equal((await runFactoryTick(ctx.root, paseo)).kind, "waiting");
  assert.equal(created.length + steers.length + ship.pushed.length + ship.opened.length, 0);
  assert.equal(field(ctx.stateFile, "ready"), undefined);
});

for (const autoMerge of [false, true]) {
  test(`green CI steers the manager once and sets ready: ci, never merging (autoMerge ${autoMerge})`, async () => {
    const { ctx } = shipSlice({ pr: "7" });
    put(join(ctx.worktree, ".orchestrator", "pipeline.json"), JSON.stringify({ autoMerge }));
    const { paseo, created } = fakePaseo();
    const steers: string[] = [];
    paseo.steer = async (line) => void steers.push(line);
    const ship = shipPorts(paseo, prAt("green"));
    for (let pass = 0; pass < 3; pass++) await runFactoryTick(ctx.root, paseo);
    assert.equal(steers.length, 1);
    assert.match(steers[0], /s1/);
    assert.match(steers[0], /https:\/\/example\.test\/pr\/7/);
    assert.equal(field(ctx.stateFile, "ready"), "ci");
    assert.equal(created.length + ship.pushed.length + ship.opened.length, 0);
  });
}

test("after a fresh compact hands the story to the new agent, the next pass starts no second one", async () => {
  const ctx = setup("agent: a1\nattempt: 1");
  const story = withStory(ctx, "step: implement\nround: 1\nagent: a1\nstatus: implementing", "implement-running", cycles(false));
  // The compact archived a1; f1 is the live replacement, carrying a1's labels.
  const { paseo, created } = fakePaseo({ a1: { status: "closed", archivedAt: "now" }, f1: { status: "idle" } });
  const initiative = createInitiativeLoop(
    async () => DEFAULT_LOOP_CONFIG,
    async () => FALLBACK_AGENT_CONFIG,
    async () => ({ phases: DEFAULT_PHASES, sources: [] }),
    async () => null,
    undefined,
    undefined,
    undefined,
    async () => ctx.root,
  );
  await initiative.handOver(sliceLabels("implement"), "a1", "f1");
  assert.equal(field(story, "agent"), "f1");
  assert.equal(field(ctx.stateFile, "agent"), "f1");

  for (let pass = 0; pass < 2; pass++) await runFactoryTick(ctx.root, paseo);
  assert.equal(created.length, 0);
});

// An adopted story whose loop agent is still the story's `agent`: the slice carries it over, so the tick reads that agent's turn.
test("an adopted story with a running loop agent gets no second agent, and its idle implement-done is committed and moves to test", async () => {
  const ctx = setup("", "on", "spec");
  adoptedStory(ctx, "step: implement\nround: 1\nagent: l-1\nstatus: implementing", "implement-running", cycles(true));
  const known: Record<string, { status: string }> = { "l-1": { status: "running" } };
  const { paseo, created, commits } = fakePaseo(known);
  assert.equal((await runFactoryTick(ctx.root, paseo)).kind, "advanced");
  assert.equal(field(ctx.stateFile, "agent"), "l-1");
  assert.equal(field(ctx.stateFile, "seat"), "builder");
  for (let pass = 0; pass < 2; pass++) assert.deepEqual(await runFactoryTick(ctx.root, paseo), { kind: "alive", slice: "s1", agent: "l-1" });
  known["l-1"].status = "idle";
  put(join(ctx.worktree, ".harness", "state.md"), `# S\n\n## Status\nimplement-done\n${cycles(true)}`);
  assert.deepEqual(await runFactoryTick(ctx.root, paseo), { kind: "advanced", slice: "s1", phase: "test" });
  assert.equal(commits.length, 1);
  assert.equal(created.length, 0);
});

test("an adopted reviewing story with a running reviewer gets no second Review agent", async () => {
  const ctx = setup("", "on", "spec");
  adoptedStory(ctx, "step: review\nround: 1\nagent: r-9\nstatus: reviewing", "review-running", cycles(true));
  const { paseo, created } = fakePaseo({ "r-9": { status: "running" } });
  await runFactoryTick(ctx.root, paseo);
  assert.equal(field(ctx.stateFile, "seat"), "reviewer");
  assert.deepEqual(await runFactoryTick(ctx.root, paseo), { kind: "alive", slice: "s1", agent: "r-9" });
  assert.equal(created.length, 0);
});

test("an adopted story with a Fix agent running on its open PR gets no second Fix agent", async () => {
  const ctx = setup("pr: 7\nkind: ship", "on", "spec");
  adoptedStory(ctx, "step: fix\nround: 1\nagent: f-9\nstatus: pr-open\npr: 7", "fix-running", `${cycles(true)}`);
  const { paseo, created } = fakePaseo({ "f-9": { status: "running" } });
  shipPorts(paseo, prAt("failing", "abc", FAILED));
  await runFactoryTick(ctx.root, paseo);
  assert.equal(field(ctx.stateFile, "agent"), "f-9");
  await runFactoryTick(ctx.root, paseo);
  assert.equal(created.length, 0);
});

test("an adopted story with no worktree line gets the slice's, so the context watch can find it", async () => {
  const ctx = setup("", "on", "spec");
  const story = adoptedStory(ctx, "step: implement\nround: 1\nagent: l-1\nstatus: implementing", "implement-running", cycles(false));
  const { paseo } = fakePaseo({ "l-1": { status: "running" } });
  await runFactoryTick(ctx.root, paseo);
  assert.equal(field(story, "worktree"), ctx.worktree);
});

test("an adopted story keeps its workspace: the slice records the story's workspace when it has none", async () => {
  // The story was started in a Paseo workspace by the loop; the slice must keep seating agents there.
  const ctx = setup("", "on", "spec");
  adoptedStory(ctx, "step: implement\nround: 1\nagent: l-1\nstatus: implementing\nworkspace: wks_x", "implement-running", cycles(false));
  const { paseo } = fakePaseo({ "l-1": { status: "running" } });
  await runFactoryTick(ctx.root, paseo);
  assert.equal(field(ctx.stateFile, "workspace"), "wks_x");
});

describe("a slice with a workspace seats its agents there", () => {
  // Arrange helper: the slice sits in Paseo workspace wks_x, so every seat must go through the host, never a bare cwd.
  const inWorkspace = (state: string) => `${state}\nworkspace: wks_x`;

  test("the build step starts through the host", async () => {
    const ctx = setup(inWorkspace("agent: p-1"), "on", "build");
    withStory(ctx, "step: plan\nround: 1\nagent: p-1\nstatus: planning", "plan-done", cycles(false));
    const { paseo, created, started, workspaces } = fakePaseo({ "p-1": { status: "idle" } });
    const result = await runFactoryTick(ctx.root, paseo);
    assert.equal(result.kind, "restarted");
    assert.equal(started.length, 1);
    assert.equal(started[0].workspace, "wks_x");
    assert.equal(field(ctx.stateFile, "agent"), (result as { agent: string }).agent);
    assert.equal(created.length, 0);
    assert.equal(workspaces.length, 0);
  });

  test("the review step starts through the host", async () => {
    const { ctx } = reviewSlice("test-done", { entering: true });
    writeFileSync(ctx.stateFile, readFileSync(ctx.stateFile, "utf8").replace("\n---\n", "\nworkspace: wks_x\n---\n"));
    const { paseo, created, started, workspaces } = fakePaseo({ "i-1": { status: "idle" } });
    assert.equal((await runFactoryTick(ctx.root, paseo)).kind, "restarted");
    assert.equal(started.length, 1);
    assert.equal(started[0].workspace, "wks_x");
    assert.equal(started[0].labels.seat, "reviewer");
    assert.equal(created.length, 0);
    assert.equal(workspaces.length, 0);
  });

  test("the QA seat starts through the host", async () => {
    const { ctx } = testSlice("implement-done", "");
    writeFileSync(ctx.stateFile, readFileSync(ctx.stateFile, "utf8").replace("\n---\n", "\nworkspace: wks_x\n---\n"));
    const { paseo, created, started, workspaces } = fakePaseo({ "i-1": { status: "idle" } });
    assert.equal((await runFactoryTick(ctx.root, paseo)).kind, "restarted");
    assert.equal(started.length, 1);
    assert.equal(started[0].workspace, "wks_x");
    assert.equal(started[0].labels.seat, "qa");
    assert.equal(created.length, 0);
    assert.equal(workspaces.length, 0);
  });

  test("a slice with no workspace still starts through agents.create", async () => {
    const { ctx } = testSlice("implement-done", "");
    const { paseo, created, started } = fakePaseo({ "i-1": { status: "idle" } });
    assert.equal((await runFactoryTick(ctx.root, paseo)).kind, "restarted");
    assert.equal(created.length, 1);
    assert.equal(started.length, 0);
  });
});

test("a story the factory writes in spec carries its worktree, so the context watch owns the step and resume reads its state", async () => {
  const ctx = setup("", "on", "spec");
  const { paseo, created } = fakePaseo();
  for (let pass = 0; pass < 2; pass++) await runFactoryTick(ctx.root, paseo);
  const story = field(ctx.stateFile, "story")!;
  assert.equal(field(story, "worktree"), ctx.worktree);
  const initiative = createInitiativeLoop(
    async () => DEFAULT_LOOP_CONFIG,
    async () => FALLBACK_AGENT_CONFIG,
    async () => ({ phases: DEFAULT_PHASES, sources: [] }),
    async () => null,
    undefined,
    undefined,
    undefined,
    async () => ctx.root,
  );
  assert.equal(created.length, 1);
  assert.equal(await initiative.stepActive(sliceLabels("plan"), "new-1"), true);
});

test("a slice naming an existing todo story with no worktree line gets the slice's, so the context watch owns its Plan agent", async () => {
  const ctx = setup("", "on", "spec");
  const story = withStory(ctx, "", "todo");
  const { paseo, created } = fakePaseo();
  for (let pass = 0; pass < 2; pass++) await runFactoryTick(ctx.root, paseo);
  assert.equal(field(ctx.stateFile, "phase"), "build");
  assert.equal(field(story, "worktree"), ctx.worktree);
  const initiative = createInitiativeLoop(
    async () => DEFAULT_LOOP_CONFIG,
    async () => FALLBACK_AGENT_CONFIG,
    async () => ({ phases: DEFAULT_PHASES, sources: [] }),
    async () => null,
    undefined,
    undefined,
    undefined,
    async () => ctx.root,
  );
  assert.equal(created.length, 1);
  assert.equal(await initiative.stepActive(sliceLabels("plan"), "new-1"), true);
});

// A blocked slice tells the manager once and leaves the runnable set, so the next slice can run.
const blockedCases: [string, () => { ctx: ReturnType<typeof setup>; known: Record<string, { status: string }>; ports?: (paseo: TickPaseo) => void }][] = [
  [
    "an Implement cycle that finished without being ticked",
    () => {
      const ctx = setup("agent: i-1");
      withStory(ctx, "step: implement\nround: 1\ncycle: 1\nagent: i-1\nstatus: implementing", "implement-done", cycles(false));
      return { ctx, known: { "i-1": { status: "idle" } } };
    },
  ],
  [
    "implement-blocked",
    () => {
      const ctx = setup("agent: i-1");
      withStory(ctx, "step: implement\nround: 1\nagent: i-1\nstatus: implementing", "implement-blocked", cycles(false));
      return { ctx, known: { "i-1": { status: "idle" } } };
    },
  ],
  [
    "diagnose-blocked",
    () => {
      const ctx = setup("agent: i-1");
      withStory(ctx, "step: diagnose\nround: 1\nagent: i-1\nstatus: planning", "diagnose-blocked", cycles(false));
      return { ctx, known: { "i-1": { status: "idle" } } };
    },
  ],
  [
    "a review still blocking at the round limit",
    () => ({ ctx: reviewSlice("review-done", { reviewRound: 3, findings: OPEN }).ctx, known: { "r-1": { status: "idle" } } }),
  ],
  [
    "a PR closed without merging",
    () => {
      const { ctx } = shipSlice({ pr: "7" });
      return { ctx, known: {}, ports: (paseo) => void shipPorts(paseo, prAt("closed")) };
    },
  ],
];
for (const [name, build] of blockedCases) {
  test(`${name} steers the manager once and sets ready: blocked`, async () => {
    const { ctx, known, ports } = build();
    const { paseo, created } = fakePaseo(known);
    ports?.(paseo);
    const steers: string[] = [];
    paseo.steer = async (line) => void steers.push(line);
    for (let pass = 0; pass < 3; pass++) await runFactoryTick(ctx.root, paseo);
    // A slice already at review round 3 also gets its one pending round 3 nudge; that isn't the block steer.
    const blocked = steers.filter((line) => !/reached review round 3/.test(line));
    assert.equal(blocked.length, 1);
    assert.match(blocked[0], /s1/);
    assert.equal(field(ctx.stateFile, "ready"), "blocked");
    assert.equal(created.length, 0);
    assert.equal(runnableSlices(readFactory(ctx.root)).length, 0);
  });
}

test("test-failed rounds don't use up the review-round budget", async () => {
  // Round 3 of the story is two QA failures and one review; the first review's findings still go back to build.
  const { ctx, story } = reviewSlice("review-done", { round: 3, findings: OPEN });
  const { paseo, created } = fakePaseo({ "r-1": { status: "idle" } });
  assert.equal((await runFactoryTick(ctx.root, paseo)).kind, "restarted");
  assert.deepEqual(created[0].labels, sliceLabels("implement", "4"));
  assert.equal(field(ctx.stateFile, "phase"), "build");
  assert.equal(field(story, "review_round"), "2");
});

test("review round 3 nudge: a review that fails at review round 2 steers once, before the implement launch", async () => {
  const log: string[] = [];
  const steers: string[] = [];
  const failReview = async (reviewRound: number, round: number) => {
    const { ctx, story } = reviewSlice("review-done", { reviewRound, round, findings: OPEN });
    const { paseo, created } = fakePaseo({ "r-1": { status: "idle" } });
    const create = paseo.agents.create.bind(paseo.agents);
    paseo.agents.create = async (spec) => (log.push("launch"), create(spec));
    paseo.steer = async (line: string) => (steers.push(line), log.push("steer"), true);
    await runFactoryTick(ctx.root, paseo);
    return { ctx, story, created };
  };
  await failReview(1, 1);
  assert.equal(steers.length, 0);
  assert.deepEqual(log, ["launch"], "round 1's fail launches round 2 and says nothing");
  log.length = 0;
  const second = await failReview(2, 2);
  assert.equal(steers.length, 1);
  assert.match(steers[0], /has reached review round 3/);
  assert.doesNotMatch(steers[0], /\$/);
  assert.deepEqual(log, ["steer", "launch"]);
  assert.equal(field(second.story, "review_round"), "3");
  assert.equal(field(second.story, "round_nudged"), "3");
  // QA failures raise the story's round without raising its review round, so a QA-only round 3 is quiet.
  const qaOnly = await failReview(1, 3);
  assert.equal(steers.length, 1);
  assert.equal(field(qaOnly.story, "round_nudged"), undefined);
  // Later ticks on a nudged story stay quiet.
  const { paseo: later } = fakePaseo({ "r-1": { status: "idle" } });
  later.steer = async (line: string) => (steers.push(line), true);
  for (let pass = 0; pass < 2; pass++) await runFactoryTick(second.ctx.root, later);
  assert.equal(steers.length, 1);
});

// The slice's round 3 steer when its review fails at review round 2, with `cost` as the telemetry port and `story` as extra frontmatter.
async function nudgeWith(cost: TickPaseo["cost"], story: Record<string, string> = {}) {
  const { ctx } = reviewSlice("review-done", { reviewRound: 2, round: 2, findings: OPEN });
  if (Object.keys(story).length) writeFrontmatter(join(ctx.root, "story.md"), story);
  const { paseo } = fakePaseo({ "r-1": { status: "idle" } });
  const steers: string[] = [];
  paseo.steer = async (line: string) => (steers.push(line), true);
  paseo.cost = cost;
  await runFactoryTick(ctx.root, paseo);
  return steers;
}
const costRow = (agentId: string, costUsd: number, story = "s1") => ({ at: "2026-01-01T00:00:00Z", agentId, provider: "claude", step: "implement", used: null, max: null, event: "turn" as const, initiative: "m1", story, costUsd });

test("review round 3 nudge: the slice's steer shows its spend against the cap, counting each agent's last cost", async () => {
  const rows = [costRow("a-1", 1), costRow("a-1", 1.2), costRow("a-2", 3), costRow("other", 9, "s2")];
  const [line] = await nudgeWith({ cap: () => 5, rows: () => rows });
  assert.match(line, /has reached review round 3, \$4\.20 of \$5 spent;/);
});

test("review round 3 nudge: the slice's own cost_cap_usd replaces the base cap", async () => {
  const [line] = await nudgeWith({ cap: () => 5, rows: () => [costRow("a-1", 4.2)] }, { cost_cap_usd: "10" });
  assert.match(line, /\$4\.20 of \$10 spent/);
});

test("review round 3 nudge: no matching cost rows leave the steer without spend", async () => {
  const [line] = await nudgeWith({ cap: () => 5, rows: () => [costRow("a-1", 4.2, "s2")] });
  assert.match(line, /has reached review round 3/);
  assert.doesNotMatch(line, /\$/);
});

test("review round 3 nudge: cost rows that fail to load still send the steer, without spend", async () => {
  const steers = await nudgeWith({ cap: () => 5, rows: () => Promise.reject(new Error("x")) });
  assert.equal(steers.length, 1);
  assert.match(steers[0], /has reached review round 3/);
  assert.doesNotMatch(steers[0], /\$/);
});

// Seat profiles: the seat's file, else its role's tier, else MANAGER_MODELS.
const deep: AgentProfile = { id: "p_deep", name: "Deep", provider: "claude", model: "claude-opus-5-5" };
const fast: AgentProfile = { id: "p_fast", name: "Fast", provider: "claude", model: "claude-sonnet-5-5" };
const grok: AgentProfile = { id: "p_grok", name: "Grok", provider: "grok", model: "grok-code" };
const runner: AgentProfile = { id: "p_runner", name: "Runner", provider: "claude", model: "claude-haiku-4-5" };

const withProfiles = (paseo: TickPaseo, list: AgentProfile[]): TickPaseo => ({
  ...paseo,
  profiles: async () => ({ list, runnerProfileId: runner.id }),
});

const seatFile = (root: string, role: string, profile = "") =>
  put(join(root, ".harness", "factory", "seats", `${role}.md`), `---\n${profile ? `profile: ${profile}\n` : ""}---\nNotes.\n`);

test("a seat file's named profile is the profile its agent is created on, on any provider", async () => {
  const { root } = setup("agent: dead-1", "on", "test");
  seatFile(root, "qa", grok.id);
  const { paseo, created } = fakePaseo({ "dead-1": { status: "error" } });
  await runFactoryTick(root, withProfiles(paseo, [deep, fast, grok, runner]));
  assert.deepEqual(created.map((item) => item.config), [{ provider: "grok/grok-code" }]);
});

test("a reviewer with no profile is created on the deep profile, and a QA seat on the fast one", async () => {
  const review = setup("agent: dead-1", "on", "review");
  const reviewing = fakePaseo({ "dead-1": { status: "error" } });
  await runFactoryTick(review.root, withProfiles(reviewing.paseo, [fast, deep, runner]));
  assert.deepEqual(reviewing.created.map((item) => item.config), [{ provider: "claude/claude-opus-5-5" }]);

  const qaSlice = setup("agent: dead-1", "on", "test");
  seatFile(qaSlice.root, "qa");
  const testing = fakePaseo({ "dead-1": { status: "error" } });
  await runFactoryTick(qaSlice.root, withProfiles(testing.paseo, [deep, fast, runner]));
  assert.deepEqual(testing.created.map((item) => item.config), [{ provider: "claude/claude-sonnet-5-5" }]);
});

test("with no matching profile, or no profiles port, a seat is created on MANAGER_MODELS[0]", async () => {
  const none = setup("agent: dead-1", "on", "test");
  const noMatch = fakePaseo({ "dead-1": { status: "error" } });
  await runFactoryTick(none.root, withProfiles(noMatch.paseo, [runner]));
  assert.deepEqual(noMatch.created.map((item) => item.config), [MANAGER_MODELS[0]]);

  const bare = setup("agent: dead-1", "on", "test");
  const noPort = fakePaseo({ "dead-1": { status: "error" } });
  await runFactoryTick(bare.root, noPort.paseo);
  assert.deepEqual(noPort.created.map((item) => item.config), [MANAGER_MODELS[0]]);

  const broken = setup("agent: dead-1", "on", "test");
  const failing = fakePaseo({ "dead-1": { status: "error" } });
  await runFactoryTick(broken.root, { ...failing.paseo, profiles: async () => { throw new Error("config unreachable"); } });
  assert.deepEqual(failing.created.map((item) => item.config), [MANAGER_MODELS[0]]);
});

test("a failed create on the seat's profile falls back to MANAGER_MODELS, and the slice records that agent", async () => {
  const { root, stateFile } = setup("agent: dead-1", "on", "test");
  const { paseo, created } = fakePaseo({ "dead-1": { status: "error" } });
  const create = paseo.agents.create;
  const attempted: unknown[] = [];
  paseo.agents.create = async (request) => {
    attempted.push(request.config);
    if (request.config.provider === "claude/claude-sonnet-5-5") throw new Error("model unavailable");
    return create(request);
  };
  const result = await runFactoryTick(root, withProfiles(paseo, [deep, fast, runner]));
  assert.deepEqual(result, { kind: "restarted", slice: "s1", agent: "new-1" });
  assert.deepEqual(attempted, [{ provider: "claude/claude-sonnet-5-5" }, MANAGER_MODELS[0]]);
  assert.deepEqual(created.map((item) => item.config), [MANAGER_MODELS[0]]);
  assert.match(readFileSync(stateFile, "utf8"), /agent: new-1/);
});

test("review round 3 nudge: a steer that returns false or throws stays pending and the next tick steers again", async () => {
  for (const failing of [async () => false, async () => Promise.reject(new Error("no manager"))]) {
    const { ctx, story } = reviewSlice("review-done", { reviewRound: 2, round: 2, findings: OPEN });
    const attempts: string[] = [];
    const { paseo } = fakePaseo({ "r-1": { status: "idle" } });
    paseo.steer = async (line: string) => {
      attempts.push(line);
      return failing();
    };
    await runFactoryTick(ctx.root, paseo);
    assert.equal(attempts.length, 1);
    assert.equal(field(story, "round_nudged"), undefined);
    // Round 3's build is under way; the tick retries the nudge and it is still not delivered.
    await runFactoryTick(ctx.root, paseo);
    assert.equal(attempts.length, 2);
    assert.equal(field(story, "round_nudged"), undefined);
    // The manager is back: the next tick delivers it, records it, and later ticks stay quiet.
    paseo.steer = async (line: string) => (attempts.push(line), true);
    await runFactoryTick(ctx.root, paseo);
    assert.equal(attempts.length, 3);
    assert.equal(field(story, "round_nudged"), "3");
    await runFactoryTick(ctx.root, paseo);
    assert.equal(attempts.length, 3);
  }
});

// A build slice whose planner finished (plan-done, idle), with `cost` as the telemetry port and `planner` its session.
async function cappedBuild(cost: TickPaseo["cost"], planner: { status: string; lastUsage?: { totalCostUsd?: number } } = { status: "idle" }) {
  const ctx = setup("agent: p-1");
  const story = withStory(ctx, "step: plan\nround: 1\nagent: p-1\nstatus: planning", "plan-done", cycles(false));
  const fake = fakePaseo({ "p-1": planner });
  const steers: string[] = [];
  fake.paseo.steer = async (line) => void steers.push(line);
  fake.paseo.cost = cost;
  const result = await runFactoryTick(ctx.root, fake.paseo);
  const again = () => runFactoryTick(ctx.root, fake.paseo);
  return { ctx, story, steers, result, created: fake.created, again };
}

test("cost cap: a build slice at its cap with its turn ended steers once, blocks with block_kind cost-cap and launches nothing", async () => {
  const { ctx, story, steers, result, created } = await cappedBuild({ cap: () => 5, rows: () => [costRow("p-1", 5)] });
  assert.equal(result.kind, "waiting");
  assert.equal(steers.length, 1);
  assert.match(steers[0], /cost cap \(\$5\.00 of \$5\)/);
  assert.equal(field(ctx.stateFile, "ready"), "blocked");
  assert.equal(field(story, "block_kind"), "cost-cap");
  assert.equal(created.length, 0);
});

test("cost cap: a build slice just under its cap launches Implement as before", async () => {
  const { ctx, steers, created } = await cappedBuild({ cap: () => 5, rows: () => [costRow("p-1", 4.99)] });
  assert.equal(created.length, 1);
  assert.equal(steers.length, 0);
  assert.equal(field(ctx.stateFile, "ready"), undefined);
});

test("cost cap: a running planner is not blocked even over the cap", async () => {
  const { ctx, steers, result } = await cappedBuild({ cap: () => 5, rows: () => [costRow("p-1", 9)] }, { status: "running" });
  assert.equal(steers.length, 0);
  assert.equal(result.kind, "alive");
  assert.equal(field(ctx.stateFile, "ready"), undefined);
});

test("cost cap: with no cost port the slice is not capped", async () => {
  const { ctx, steers, created } = await cappedBuild(undefined);
  assert.equal(created.length, 1);
  assert.equal(steers.length, 0);
  assert.equal(field(ctx.stateFile, "ready"), undefined);
});

test("cost cap: the slice agent's live cost counts with rows, even when that agent has no row yet", async () => {
  // $3 on another agent's row plus $2.50 live on the planner reaches the $5 cap.
  const { ctx, story, steers, created } = await cappedBuild(
    { cap: () => 5, rows: () => [costRow("a-0", 3)] },
    { status: "idle", lastUsage: { totalCostUsd: 2.5 } },
  );
  assert.equal(steers.length, 1);
  assert.match(steers[0], /cost cap \(\$5\.50 of \$5\)/);
  assert.equal(field(ctx.stateFile, "ready"), "blocked");
  assert.equal(field(story, "block_kind"), "cost-cap");
  assert.equal(created.length, 0);
});

test("cost cap: a cost reader that throws skips the check and the step launches", async () => {
  const { ctx, steers, created } = await cappedBuild(
    { cap: () => 5, rows: () => Promise.reject(new Error("x")) },
    { status: "idle", lastUsage: { totalCostUsd: 9 } },
  );
  assert.equal(created.length, 1);
  assert.equal(steers.length, 0);
  assert.equal(field(ctx.stateFile, "ready"), undefined);
});

test("cost cap: a slice left at ready blocked stays idle over two passes, with no steer and nothing launched", async () => {
  const { ctx, steers, created, again } = await cappedBuild({ cap: () => 5, rows: () => [costRow("p-1", 5)] });
  // The first pass blocked it with one steer; two more passes must neither steer nor launch.
  const second = await again();
  const third = await again();
  assert.equal(second.kind, "idle");
  assert.equal(third.kind, "idle");
  assert.equal(steers.length, 1);
  assert.equal(created.length, 0);
  assert.equal(field(ctx.stateFile, "ready"), "blocked");
});

test("cost cap: clearing ready raises the cap by the base cap, removes block_kind and launches the step", async () => {
  const { ctx, story, steers, created, again } = await cappedBuild({ cap: () => 5, rows: () => [costRow("p-1", 5)] });
  writeFrontmatter(ctx.stateFile, { ready: null });
  await again();
  assert.equal(field(story, "cost_cap_usd"), "10");
  assert.equal(field(story, "block_kind"), undefined);
  assert.equal(created.length, 1);
  assert.equal(steers.length, 1);
});

test("cost cap: a cap the manager raised by hand is kept when ready is cleared, and the step launches", async () => {
  const { ctx, story, created, again } = await cappedBuild({ cap: () => 5, rows: () => [costRow("p-1", 5)] });
  writeFrontmatter(ctx.stateFile, { ready: null });
  writeFrontmatter(story, { cost_cap_usd: 20 });
  await again();
  assert.equal(field(story, "cost_cap_usd"), "20");
  assert.equal(field(story, "block_kind"), undefined);
  assert.equal(created.length, 1);
});

test("cost cap: the QA seat carries the slice's spend labels, so its spend counts toward the cap", async () => {
  const { ctx } = testSlice("implement-done", "");
  const { paseo, created } = fakePaseo({ "i-1": { status: "idle" } });
  await runFactoryTick(ctx.root, paseo);
  assert.equal(created.length, 1);
  assert.equal(created[0].labels.seat, "qa");
  assert.equal(created[0].labels["loop-initiative"], "m1");
  assert.equal(created[0].labels["loop-story"], "s1");
});

test("cost cap: a ship slice over its cap is not blocked", async () => {
  const { ctx, story } = shipSlice();
  const { paseo } = fakePaseo();
  const steers: string[] = [];
  paseo.steer = async (line) => void steers.push(line);
  paseo.cost = { cap: () => 5, rows: () => [costRow("p-1", 9)] };
  const ship = shipPorts(paseo, prAt("pending"));
  await runFactoryTick(ctx.root, paseo);
  assert.equal(ship.opened.length, 1);
  assert.equal(steers.length, 0);
  assert.equal(field(ctx.stateFile, "ready"), undefined);
  assert.equal(field(story, "block_kind"), undefined);
});

test("cost cap: a review slice at its cap with its turn ended steers once, blocks and launches nothing", async () => {
  const { ctx, story } = reviewSlice("review-done", { findings: OPEN });
  const { paseo, created } = fakePaseo({ "r-1": { status: "idle" } });
  const steers: string[] = [];
  paseo.steer = async (line) => void steers.push(line);
  paseo.cost = { cap: () => 5, rows: () => [costRow("r-1", 5)] };
  const result = await runFactoryTick(ctx.root, paseo);
  assert.equal(result.kind, "waiting");
  assert.equal(steers.length, 1);
  assert.match(steers[0], /cost cap \(\$5\.00 of \$5\)/);
  assert.equal(field(ctx.stateFile, "ready"), "blocked");
  assert.equal(field(story, "block_kind"), "cost-cap");
  assert.equal(created.length, 0);
});

test("cost cap: a test slice entering QA at its cap blocks and launches no seat", async () => {
  const { ctx, story } = testSlice("implement-done", "");
  const { paseo, created } = fakePaseo({ "i-1": { status: "idle" } });
  const steers: string[] = [];
  paseo.steer = async (line) => void steers.push(line);
  paseo.cost = { cap: () => 5, rows: () => [costRow("i-1", 5)] };
  await runFactoryTick(ctx.root, paseo); // build hands over to test
  await runFactoryTick(ctx.root, paseo);
  assert.equal(steers.length, 1);
  assert.equal(field(ctx.stateFile, "ready"), "blocked");
  assert.equal(field(story, "block_kind"), "cost-cap");
  assert.equal(created.length, 0);
});

test("cost cap: after ready is cleared, a cost reader that throws keeps the slice waiting and the raise happens once it reads", async () => {
  const rows = [costRow("p-1", 5)];
  let broken = false;
  const { ctx, story, steers, created, again } = await cappedBuild({ cap: () => 5, rows: () => (broken ? Promise.reject(new Error("x")) : rows) });
  writeFrontmatter(ctx.stateFile, { ready: null });
  broken = true;
  const waiting = await again();
  assert.equal(waiting.kind, "waiting");
  assert.equal(created.length, 0);
  assert.equal(field(story, "block_kind"), "cost-cap");
  broken = false;
  await again();
  assert.equal(field(story, "cost_cap_usd"), "10");
  assert.equal(created.length, 1);
  assert.equal(steers.length, 1);
});

// A second slice beside setup's s1, in the same mission; `state` is its state.md frontmatter beyond the phase and run.
function addSlice(root: string, id: string, state: string, phase = "spec") {
  const dir = sliceDir(root, "m1", id);
  put(join(dir, "spec.md"), `Do ${id}.\n`);
  put(join(dir, "state.md"), `---\nphase: ${phase}\nrun: on\n${state}\n---\n`);
  return join(dir, "state.md");
}

// A fake whose worktrees land in <cwd>/wt-<slug>, so two slices get two folders; the shared fake always makes made-wt.
function perSlicePaseo(known: Parameters<typeof fakePaseo>[0] = {}) {
  const fake = fakePaseo(known);
  const slugs: string[] = [];
  const made = fake.paseo.host!.createStoryWorkspace;
  fake.paseo.host!.createStoryWorkspace = async (input) => {
    slugs.push(input.worktreeSlug);
    const workspace = await made(input);
    const directory = join(input.repoRoot, `wt-${input.worktreeSlug}`);
    mkdirSync(directory, { recursive: true });
    return { id: workspace.id, directory };
  };
  delete fake.paseo.steps;
  return { ...fake, slugs };
}

test("two independent spec slices each get their own worktree, then their own seat agent in it", async () => {
  // Arrange: s1 and s2 both runnable, neither has a worktree yet.
  const first = setup("", "on", "spec");
  rmSync(first.worktree, { recursive: true });
  const secondState = addSlice(first.root, "s2", "");
  const { paseo, created, started, slugs } = perSlicePaseo();

  // Act: the first pass hands both specs off.
  const handoff = await runFactoryTick(first.root, paseo);

  // Assert: two worktrees, different slugs and folders, one per slice.
  assert.equal(handoff.kind, "fan-out");
  assert.equal(slugs.length, 2);
  assert.notEqual(slugs[0], slugs[1]);
  const worktrees = [field(first.stateFile, "worktree"), field(secondState, "worktree")];
  assert.notEqual(worktrees[0], worktrees[1]);
  assert.deepEqual(worktrees, slugs.map((slug) => join(first.root, `wt-${slug}`)));
  assert.equal(created.length, 0);

  // Act: the next pass works the build seats.
  const seats = await runFactoryTick(first.root, paseo);

  // Assert: one agent per slice, each in that slice's own workspace.
  assert.equal(seats.kind, "fan-out");
  assert.deepEqual(started.map((agent) => agent.workspace).sort(), [field(first.stateFile, "workspace"), field(secondState, "workspace")].sort());
  assert.deepEqual(started.map((agent) => agent.labels.slice).sort(), ["s1", "s2"]);
  assert.equal(created.length, 0);
});

test("a slice that depends on a reviewed slice with an empty proof.md gets no worktree and no agent, while an independent slice does", async () => {
  // Arrange: s1 is reviewed (`ready: review`) but its proof.md is empty; s2 depends on it; s3 depends on nothing.
  const { root, worktree } = setup("ready: review", "on", "spec");
  rmSync(worktree, { recursive: true });
  const dependentState = addSlice(root, "s2", "depends: s1");
  const freeState = addSlice(root, "s3", "");
  writeFileSync(join(sliceDir(root, "m1", "s1"), "proof.md"), "\n");
  const { paseo, started, slugs } = perSlicePaseo();

  // Act: the handoff pass, then the seat pass.
  const handoff = await runFactoryTick(root, paseo);
  const seat = await runFactoryTick(root, paseo);

  // Assert: only the independent s3 moved; s2 waits on s1's proof.
  assert.deepEqual(handoff, { kind: "advanced", slice: "s3", phase: "build" });
  assert.equal(seat.kind, "restarted");
  assert.deepEqual(slugs, ["s3"]);
  assert.deepEqual(started.map((agent) => agent.labels.slice), ["s3"]);
  assert.equal(started[0].workspace, field(freeState, "workspace"));
  assert.equal(field(dependentState, "worktree"), undefined);
  assert.equal(field(dependentState, "agent"), undefined);
});

test("when the first slice's agent can't be started, the second still gets its agent and the pass rejects", async () => {
  // Arrange: two build slices with worktrees; starting an agent in s1's folder always throws.
  const { root, worktree, stateFile } = setup("", "on", "build");
  const otherTree = join(root, "wt2");
  mkdirSync(otherTree);
  const otherState = addSlice(root, "s2", `worktree: ${otherTree}`, "build");
  const { paseo, created } = perSlicePaseo();
  const started = paseo.agents.create;
  paseo.agents.create = async (request) => {
    if (request.cwd === worktree) throw new Error("no capacity for s1");
    return started(request);
  };

  // Act and assert: the pass rejects with the first slice's error.
  await assert.rejects(runFactoryTick(root, paseo), /no capacity for s1/);

  // Assert: s2 was still worked, and s1 recorded nothing.
  assert.deepEqual(created.map((agent) => agent.cwd), [otherTree]);
  assert.equal(field(otherState, "agent"), "new-1");
  assert.equal(field(stateFile, "agent"), undefined);
});

test("when several slices can't start an agent, the pass rejects with every failure", async () => {
  // Arrange: two build slices with worktrees; starting an agent always throws, with a message naming the folder.
  const { root, worktree } = setup("", "on", "build");
  const otherTree = join(root, "wt2");
  mkdirSync(otherTree);
  addSlice(root, "s2", `worktree: ${otherTree}`, "build");
  const { paseo } = perSlicePaseo();
  paseo.agents.create = async (request) => {
    throw new Error(`no capacity for ${request.cwd}`);
  };

  // Act and assert: one AggregateError carrying both errors.
  await assert.rejects(runFactoryTick(root, paseo), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map((item) => (item as Error).message).sort(), [`no capacity for ${otherTree}`, `no capacity for ${worktree}`].sort());
    return true;
  });
});

// A steer-collecting perSlicePaseo.
function steeringPaseo(known: Parameters<typeof fakePaseo>[0] = {}) {
  const fake = perSlicePaseo(known);
  const steers: string[] = [];
  fake.paseo.steer = async (line) => steers.push(line);
  return { ...fake, steers };
}

test("a run: on slice whose dependency is blocked steers the manager once over two passes and does not start", async () => {
  // Arrange: s1 is blocked; s2 depends on it.
  const { root } = setup("ready: blocked", "on", "build");
  const dependentState = addSlice(root, "s2", "depends: s1");
  const { paseo, steers, created, slugs } = steeringPaseo();

  // Act: two passes.
  await runFactoryTick(root, paseo);
  await runFactoryTick(root, paseo);

  // Assert: one steer naming s2 and its cause, recorded in state.md; s2 got no worktree and no agent.
  assert.deepEqual(steers, ["Slice s2 can't start: blocked dependency s1."]);
  assert.equal(field(dependentState, "held"), "blocked dependency s1");
  assert.deepEqual(slugs, []);
  assert.equal(created.length, 0);
});

for (const [name, other] of [
  ["an unknown id", ""],
  ["a slice of another mission", "elsewhere"],
] as const) {
  test(`a run: on slice that depends on ${name} steers the manager once and does not start`, async () => {
    // Arrange: s1 depends on an id that is no slice of m1.
    const { root, worktree, stateFile } = setup(`depends: ${other || "ghost"}`, "on", "spec");
    rmSync(worktree, { recursive: true });
    if (other) {
      put(join(root, ".harness", "factory", "missions", "m2", "mission.md"), "Outcome: elsewhere.\n");
      put(join(sliceDir(root, "m2", other), "state.md"), "---\nphase: spec\n---\n");
    }
    const { paseo, steers, slugs } = steeringPaseo();

    // Act: two passes.
    await runFactoryTick(root, paseo);
    await runFactoryTick(root, paseo);

    // Assert: one steer naming the unknown dependency; s1 never got a worktree.
    assert.deepEqual(steers, [`Slice s1 can't start: unknown dependency ${other || "ghost"}.`]);
    assert.equal(field(stateFile, "held"), `unknown dependency ${other || "ghost"}`);
    assert.deepEqual(slugs, []);
  });
}

test("a slice waiting on a dependency still in progress does not steer", async () => {
  // Arrange: s1 is in build with a live agent; s2 depends on it.
  const { root } = setup("agent: a1", "on", "build");
  const dependentState = addSlice(root, "s2", "depends: s1");
  const { paseo, steers } = steeringPaseo({ a1: { status: "running" } });

  // Act
  const result = await runFactoryTick(root, paseo);

  // Assert: s1 is worked, s2 waits in silence.
  assert.deepEqual(result, { kind: "alive", slice: "s1", agent: "a1" });
  assert.deepEqual(steers, []);
  assert.equal(field(dependentState, "held"), undefined);
});

test("the held note clears when its cause goes away, and a later cause steers again", async () => {
  // Arrange: s1 is blocked with a live agent; s2 depends on it.
  const { root } = setup("agent: a1\nready: blocked", "on", "build");
  const dependentState = addSlice(root, "s2", "depends: s1");
  const { paseo, steers } = steeringPaseo({ a1: { status: "running" } });

  // Act: blocked, then the manager unblocks s1, then s1 blocks again.
  await runFactoryTick(root, paseo);
  writeSliceState(root, "m1", "s1", { ready: null });
  await runFactoryTick(root, paseo);
  const cleared = field(dependentState, "held");
  writeSliceState(root, "m1", "s1", { ready: "blocked" });
  await runFactoryTick(root, paseo);

  // Assert: the note cleared in between, and each blocked spell steered once.
  assert.equal(cleared, undefined);
  assert.deepEqual(steers, ["Slice s2 can't start: blocked dependency s1.", "Slice s2 can't start: blocked dependency s1."]);
  assert.equal(field(dependentState, "held"), "blocked dependency s1");
});

test("a held note the manager never received is not saved, and the next pass with a manager steers once and saves it", async () => {
  // Arrange: s1 is blocked; s2 depends on it; no manager yet, so steer resolves false.
  const { root } = setup("ready: blocked", "on", "build");
  const dependentState = addSlice(root, "s2", "depends: s1");
  const { paseo, steers } = steeringPaseo();
  paseo.steer = async () => false;

  // Act: a pass with no manager, then the manager appears and two more passes run.
  await runFactoryTick(root, paseo);
  const unsent = field(dependentState, "held");
  paseo.steer = async (line) => steers.push(line);
  await runFactoryTick(root, paseo);
  await runFactoryTick(root, paseo);

  // Assert: nothing saved until a steer was delivered, then one steer and the note.
  assert.equal(unsent, undefined);
  assert.deepEqual(steers, ["Slice s2 can't start: blocked dependency s1."]);
  assert.equal(field(dependentState, "held"), "blocked dependency s1");
});

test("with no steer port a held slice saves no note", async () => {
  // Arrange: s1 is blocked; s2 depends on it; the ports have no steer.
  const { root } = setup("ready: blocked", "on", "build");
  const dependentState = addSlice(root, "s2", "depends: s1");
  const { paseo } = steeringPaseo();
  delete paseo.steer;

  // Act
  await runFactoryTick(root, paseo);

  // Assert
  assert.equal(field(dependentState, "held"), undefined);
});

test("a steer that throws leaves the held note unsaved, does not stop other slices, and the next pass retries", async () => {
  // Arrange: s1 is blocked; s2 depends on it; s3 is runnable; the first steer throws.
  const { root } = setup("ready: blocked", "on", "build");
  const dependentState = addSlice(root, "s2", "depends: s1");
  addSlice(root, "s3", "");
  const { paseo, steers, slugs } = steeringPaseo();
  paseo.steer = async () => {
    throw new Error("manager unreachable");
  };

  // Act: a pass whose steer throws, then a pass whose steer is delivered.
  await runFactoryTick(root, paseo);
  const unsent = field(dependentState, "held");
  const ranOthers = slugs.length;
  paseo.steer = async (line) => steers.push(line);
  await runFactoryTick(root, paseo);

  // Assert: the throw saved nothing and s3 still ran; the retry steered once and saved the note.
  assert.equal(unsent, undefined);
  assert.ok(ranOthers > 0);
  assert.deepEqual(steers, ["Slice s2 can't start: blocked dependency s1."]);
  assert.equal(field(dependentState, "held"), "blocked dependency s1");
});

test("a named story that already has a worktree line still gets the new workspace written into its frontmatter", async () => {
  // Arrange: a fresh slice naming a story that has `worktree` but no `workspace`.
  const ctx = setup("", "on", "spec");
  rmSync(ctx.worktree, { recursive: true });
  const story = join(ctx.root, "story.md");
  put(story, "---\ntitle: Named\nstatus: todo\nworktree: /old/wt\n---\n\nBody.\n");
  writeFileSync(ctx.stateFile, readFileSync(ctx.stateFile, "utf8").replace("\n---\n", `\nstory: ${story}\n---\n`));
  const { paseo } = fakePaseo();

  // Act
  await runFactoryTick(ctx.root, paseo);

  // Assert: the story carries the slice's workspace, and keeps the worktree line it had.
  assert.equal(field(story, "workspace"), field(ctx.stateFile, "workspace"));
  assert.ok(field(story, "workspace"));
  assert.equal(field(story, "worktree"), "/old/wt");
});
