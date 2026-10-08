import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { DEFAULT_LOOP_CONFIG } from "../shared/initiative-loop";
import { FALLBACK_AGENT_CONFIG } from "../shared/agent-runner";
import { DEFAULT_PHASES, type SkillSource } from "../shared/pipeline";
import { frontmatter, writeFrontmatter } from "./harness-layout";
import { sourceId } from "./skill-sources";

// The loop's registry lives under the home folder, so each run gets its own.
const home = mkdtempSync(join(tmpdir(), "loop-home-"));
process.env.HOME = home;
const { createInitiativeLoop, RESUME_LINE } = await import("./initiative-loop");

type PaseoApi = PluginHandlerContext["paseo"];
type Agent = { id: string; labels: Record<string, string> };

// A repo with one initiative (loop on), one phase and one story mid-Implement in a worktree.
function fixture(agent = "a1") {
  const root = mkdtempSync(join(tmpdir(), "loop-repo-"));
  const worktree = join(root, "wt");
  const init = join(root, ".harness", "initiatives", "demo");
  const phase = join(init, "phases", "1-meter");
  mkdirSync(join(phase, "stories"), { recursive: true });
  mkdirSync(join(worktree, ".harness"), { recursive: true });
  // The loop commits each finished step in the worktree, so it has to be a repo.
  execFileSync("git", ["init", "-q"], { cwd: worktree });
  writeFileSync(join(init, "initiative.md"), "---\nloop: on\n---\n# Initiative: Demo\n", "utf8");
  writeFileSync(join(phase, "phase.md"), "---\nphase: 1\ntitle: Meter\n---\n", "utf8");
  const story = join(phase, "stories", "01-story.md");
  writeFileSync(
    story,
    `---\nid: S1\ntitle: Demo story\nstatus: implementing\nstep: implement\nround: 1\nbranch: feature/s1\nbase: origin/main\nworkspace: ws1\nworktree: ${worktree}\nagent: ${agent}\n---\n\n## Goal\n\nShip it.\n`,
    "utf8",
  );
  writeFileSync(join(worktree, ".harness", "state.md"), "# S1 — Demo story\n\n## Status\nimplement-running\n", "utf8");
  mkdirSync(join(home, ".orchestrator"), { recursive: true });
  writeFileSync(join(home, ".orchestrator", "initiative-loops.json"), JSON.stringify([root]), "utf8");
  const labels = {
    kind: "initiative-loop",
    "loop-repo": root,
    "loop-initiative": "demo",
    "loop-phase": "1-meter",
    "loop-story": "S1",
    "loop-step": "implement",
    "loop-round": "1",
  };
  return { root, worktree, story, labels };
}

// A fake Paseo: live agents by id; workspace creates are recorded and become live agents.
function fakePaseo(live: Agent[]) {
  const created: {
    workspace: string;
    title: string;
    labels: Record<string, string>;
    config?: unknown;
    prompt?: string;
  }[] = [];
  const api = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => {
          const found = live.find((agent) => agent.id === id);
          return found ? { agent: { labels: found.labels } } : null;
        },
      }),
      list: async () => ({ entries: live.map((agent) => ({ agent })) }),
    },
    workspaces: {
      ref: (workspace: string) => ({
        agents: {
          create: async (options: {
            title: string;
            labels: Record<string, string>;
            config?: unknown;
            prompt?: string;
          }) => {
            const id = `n${created.length + 1}`;
            created.push({
              workspace,
              title: options.title,
              labels: options.labels,
              config: options.config,
              prompt: options.prompt,
            });
            live.push({ id, labels: options.labels });
            return { id };
          },
        },
      }),
    },
  };
  return { api: api as unknown as PaseoApi, created };
}

const noExtras = async () => ({ phases: DEFAULT_PHASES, sources: [] });
const loop = () =>
  createInitiativeLoop(async () => DEFAULT_LOOP_CONFIG, async () => FALLBACK_AGENT_CONFIG, noExtras);
const storyMeta = (file: string) => frontmatter(readFileSync(file, "utf8"));

test("handOver moves agent: only when it names the old id", async () => {
  const { story, labels } = fixture("a1");
  const initiative = loop();

  await initiative.handOver(labels, "a1", "a2");
  assert.equal(storyMeta(story).agent, "a2");

  await initiative.handOver(labels, "a1", "a3");
  assert.equal(storyMeta(story).agent, "a2");
});

test("resumePrompt is the step prompt plus the resume line", async () => {
  const { labels } = fixture();
  const prompt = await loop().resumePrompt(labels);

  assert.ok(prompt);
  assert.match(prompt, /^Implement for story S1 — Demo story\.$/m);
  assert.match(prompt, /## This step: implement the story/);
  assert.ok(prompt.endsWith(`\n\n${RESUME_LINE}`));
  assert.equal(await loop().resumePrompt({ ...labels, "loop-story": "S9" }), null);
});

test("resumePrompt gives a cycle agent back its cycle and the plan", async () => {
  const { worktree, labels } = fixture();
  writeFileSync(
    join(worktree, ".harness", "state.md"),
    "# S1 — Demo story\n\n## Status\nimplement-running\n\n## Plan\nChange server/meter.ts.\n\n## Cycles\n- [x] Cycle 1 — Reads: test → change\n- [ ] Cycle 2 — Warns: warning test → warn once\n",
    "utf8",
  );
  const prompt = await loop().resumePrompt({ ...labels, "loop-cycle": "2" });

  assert.ok(prompt);
  assert.match(prompt, /^Implement cycle 2 for story S1 — Demo story\.$/m);
  assert.match(prompt, /## Cycle 2 only\n- \[ \] Cycle 2 — Warns/);
  assert.match(prompt, /Change server\/meter\.ts\./);
  assert.ok(prompt.endsWith(`\n\n${RESUME_LINE}`));
});

test("resumePrompt gives a parent Implement agent back only the cycles still unticked", async () => {
  const { worktree, labels } = fixture();
  writeFileSync(
    join(worktree, ".harness", "state.md"),
    "# S1 — Demo story\n\n## Status\nimplement-running\n\n## Plan\nChange server/meter.ts.\n\n## Cycles\n- [x] Cycle 1 — Reads: test → change\n- [ ] Cycle 2 — Warns: warning test → warn once\n- [ ] Cycle 3 — Resets: reset test → clear\n",
    "utf8",
  );
  const prompt = await loop().resumePrompt({ ...labels, "loop-cycles": "subagents" });

  assert.ok(prompt);
  assert.match(prompt, /## This step: run the cycles in subagents/);
  assert.match(prompt, /## Cycles to run\n- \[ \] Cycle 2 — Warns.*\n- \[ \] Cycle 3 — Resets/);
  assert.doesNotMatch(prompt, /Cycle 1 — Reads/);
  assert.match(prompt, /Change server\/meter\.ts\./);
  assert.ok(prompt.endsWith(`\n\n${RESUME_LINE}`));
});

test("after a hand-over, the new agent's implement-done starts exactly one Review agent; a repeat turn end and a tick start none", async () => {
  const { story, worktree, labels } = fixture("a1");
  // The fresh compact archived a1; f1 carries the same loop labels.
  const { api, created } = fakePaseo([{ id: "f1", labels: { ...labels, "context-from": "a1" } }]);
  const initiative = loop();
  await initiative.handOver(labels, "a1", "f1");
  writeFileSync(join(worktree, ".harness", "state.md"), "# S1 — Demo story\n\n## Status\nimplement-done\n", "utf8");
  const turnEnded = { agent: { id: "f1" }, outcome: { kind: "completed" } } as unknown as Parameters<
    ReturnType<typeof loop>["onTurnEnded"]
  >[1];

  await initiative.onTurnEnded(api, turnEnded);
  await initiative.onTurnEnded(api, turnEnded);
  await initiative.tick();

  assert.deepEqual(
    created.map((agent) => [agent.workspace, agent.labels["loop-step"], agent.labels["loop-round"]]),
    [["ws1", "review", "1"]],
  );
  assert.equal(storyMeta(story).agent, "n1");
  assert.equal(storyMeta(story).step, "review");
});

test("a started step's agent gets the config readAgentConfig returns for that step and the loop config", async () => {
  const { worktree, labels } = fixture("a1");
  const { api, created } = fakePaseo([{ id: "a1", labels }]);
  const asked: [string, unknown][] = [];
  const initiative = createInitiativeLoop(
    async () => DEFAULT_LOOP_CONFIG,
    async (_api, step, loopConfig) => {
      asked.push([step, loopConfig]);
      return { provider: `claude/${step}-model`, modeId: "auto" };
    },
    noExtras,
  );
  writeFileSync(join(worktree, ".harness", "state.md"), "# S1 — Demo story\n\n## Status\nimplement-done\n", "utf8");
  const turnEnded = { agent: { id: "a1" }, outcome: { kind: "completed" } } as unknown as Parameters<
    ReturnType<typeof loop>["onTurnEnded"]
  >[1];

  await initiative.onTurnEnded(api, turnEnded);

  assert.deepEqual(asked, [["review", DEFAULT_LOOP_CONFIG]]);
  assert.deepEqual(
    created.map((agent) => [agent.labels["loop-step"], agent.config]),
    [["review", { provider: "claude/review-model", modeId: "auto" }]],
  );
});

test("a Review agent started with a missing Plan path is created and told; resumePrompt says the same", async () => {
  const { worktree, labels } = fixture("a1");
  const { api, created } = fakePaseo([{ id: "a1", labels }]);
  // The loop commits the finished step, and this test leaves a file to commit.
  execFileSync("git", ["config", "user.email", "loop@test"], { cwd: worktree });
  execFileSync("git", ["config", "user.name", "Loop"], { cwd: worktree });
  mkdirSync(join(worktree, "server"), { recursive: true });
  writeFileSync(join(worktree, "server", "meter.ts"), "export {};\n", "utf8");
  writeFileSync(
    join(worktree, ".harness", "state.md"),
    "# S1 — Demo story\n\n## Status\nimplement-done\n\n## Plan\n**Files:** `server/meter.ts`, `server/gone.ts`, `server/fresh.ts` (new)\n",
    "utf8",
  );
  const turnEnded = { agent: { id: "a1" }, outcome: { kind: "completed" } } as unknown as Parameters<
    ReturnType<typeof loop>["onTurnEnded"]
  >[1];
  const initiative = loop();

  await initiative.onTurnEnded(api, turnEnded);

  const line = "These paths in ## Plan don't exist: server/gone.ts. Find the right ones and correct ## Plan.";
  assert.deepEqual(created.map((agent) => agent.labels["loop-step"]), ["review"]);
  assert.ok(created[0].prompt?.includes(line));
  const resumed = await initiative.resumePrompt(created[0].labels);
  assert.ok(resumed?.includes(line));
});

// A folder source holding skills/tdd/SKILL.md.
function tddSource(): SkillSource {
  const location = join(realpathSync(mkdtempSync(join(tmpdir(), "loop-source-"))), "source");
  mkdirSync(join(location, "skills", "tdd"), { recursive: true });
  writeFileSync(join(location, "skills", "tdd", "SKILL.md"), "---\nname: tdd\ndescription: Red, green.\n---\n# TDD\n", "utf8");
  return { id: sourceId(location), label: "source", location, kind: "personal", enabled: true, pin: null };
}

// Fakes the turn end of the story's plan agent a1, with Implement cycle 1 next.
function planDone() {
  const fx = fixture("a1");
  writeFrontmatter(fx.story, { status: "planning", step: "plan" });
  const { api, created } = fakePaseo([{ id: "a1", labels: { ...fx.labels, "loop-step": "plan" } }]);
  writeFileSync(
    join(fx.worktree, ".harness", "state.md"),
    "# S1 — Demo story\n\n## Status\nplan-done\n\n## Cycles\n- [ ] Cycle 1 — Reads: test → change\n",
    "utf8",
  );
  const turnEnded = (id: string) =>
    ({ agent: { id }, outcome: { kind: "completed" } }) as unknown as Parameters<ReturnType<typeof loop>["onTurnEnded"]>[1];
  return { ...fx, api, created, turnEnded };
}

test("plan-done with two unticked cycles starts one parent Implement agent; with subagentCycles off, the Cycle 1 agent", async () => {
  const twoCycles =
    "# S1 — Demo story\n\n## Status\nplan-done\n\n## Plan\nChange server/meter.ts.\n\n## Cycles\n- [ ] Cycle 1 — Reads: test → change\n- [ ] Cycle 2 — Warns: warning test → warn once\n";
  const parent = planDone();
  writeFileSync(join(parent.worktree, ".harness", "state.md"), twoCycles, "utf8");

  await loop().onTurnEnded(parent.api, parent.turnEnded("a1"));

  assert.equal(parent.created.length, 1);
  const [agent] = parent.created;
  assert.equal(agent.labels["loop-step"], "implement");
  assert.equal(agent.labels["loop-cycles"], "subagents");
  assert.equal(agent.labels["loop-cycle"], undefined);
  assert.match(agent.prompt ?? "", /## This step: run the cycles in subagents/);
  assert.match(agent.prompt ?? "", /## Cycles to run\n- \[ \] Cycle 1 — Reads.*\n- \[ \] Cycle 2 — Warns/);
  assert.equal(storyMeta(parent.story).cycles, "subagents");
  assert.equal(storyMeta(parent.story).cycle, undefined);

  const perCycle = planDone();
  writeFileSync(join(perCycle.worktree, ".harness", "state.md"), twoCycles, "utf8");
  const off = createInitiativeLoop(
    async () => ({ ...DEFAULT_LOOP_CONFIG, subagentCycles: false }),
    async () => FALLBACK_AGENT_CONFIG,
    noExtras,
  );

  await off.onTurnEnded(perCycle.api, perCycle.turnEnded("a1"));

  assert.deepEqual(
    perCycle.created.map((item) => [item.labels["loop-cycle"], item.labels["loop-cycles"]]),
    [["1", undefined]],
  );
  assert.match(perCycle.created[0].prompt ?? "", /## Cycle 1 only/);
  assert.equal(storyMeta(perCycle.story).cycles, undefined);
});

test("the parent's implement-done commits once and starts Review; with a cycle unticked the story blocks", async () => {
  const finish = (cycles: string) => {
    const fx = fixture("a1");
    writeFrontmatter(fx.story, { cycles: "subagents" });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: fx.worktree, encoding: "utf8" }).trim();
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(join(fx.worktree, "meter.ts"), "export const meter = 1;\n", "utf8");
    writeFileSync(
      join(fx.worktree, ".harness", "state.md"),
      `# S1 — Demo story\n\n## Status\nimplement-done\n\n## Cycles\n${cycles}`,
      "utf8",
    );
    const { api, created } = fakePaseo([{ id: "a1", labels: { ...fx.labels, "loop-cycles": "subagents" } }]);
    const turnEnded = { agent: { id: "a1" }, outcome: { kind: "completed" } } as unknown as Parameters<
      ReturnType<typeof loop>["onTurnEnded"]
    >[1];
    return { ...fx, api, created, turnEnded, git };
  };

  const done = finish("- [x] Cycle 1 — Reads: test → change\n- [x] Cycle 2 — Warns: warning test → warn once\n");
  await loop().onTurnEnded(done.api, done.turnEnded);

  assert.equal(done.git("log", "--format=%s"), "S1: Implement");
  assert.deepEqual(
    done.created.map((agent) => [agent.labels["loop-step"], agent.labels["loop-round"]]),
    [["review", "1"]],
  );

  const open = finish("- [x] Cycle 1 — Reads: test → change\n- [ ] Cycle 2 — Warns: warning test → warn once\n");
  await loop().onTurnEnded(open.api, open.turnEnded);

  assert.equal(open.created.length, 0);
  assert.equal(storyMeta(open.story).status, "blocked");
  assert.match(storyMeta(open.story).blocked_reason ?? "", /Cycle 2/);
});

test("a per-cycle agent's implement-done with cycles left hands them to one parent Implement agent", async () => {
  const fx = fixture("a1");
  writeFrontmatter(fx.story, { cycle: 1 });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fx.worktree, encoding: "utf8" }).trim();
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(fx.worktree, "meter.ts"), "export const meter = 1;\n", "utf8");
  writeFileSync(
    join(fx.worktree, ".harness", "state.md"),
    "# S1 — Demo story\n\n## Status\nimplement-done\n\n## Cycles\n- [x] Cycle 1 — Reads: test → change\n- [ ] Cycle 2 — Warns: warning test → warn once\n- [ ] Cycle 3 — Resets: reset test → reset\n",
    "utf8",
  );
  const { api, created } = fakePaseo([{ id: "a1", labels: { ...fx.labels, "loop-cycle": "1" } }]);
  const turnEnded = { agent: { id: "a1" }, outcome: { kind: "completed" } } as unknown as Parameters<
    ReturnType<typeof loop>["onTurnEnded"]
  >[1];

  await loop().onTurnEnded(api, turnEnded);

  assert.equal(git("log", "--format=%s"), "S1: Cycle 1 — Reads");
  assert.deepEqual(
    created.map((agent) => [agent.labels["loop-cycle"], agent.labels["loop-cycles"]]),
    [[undefined, "subagents"]],
  );
  assert.match(created[0].prompt ?? "", /## Cycles to run\n- \[ \] Cycle 2 — Warns.*\n- \[ \] Cycle 3 — Resets/);
  assert.equal(storyMeta(fx.story).cycles, "subagents");
});

test("an older Implement agent without the parent label doesn't move a story its parent owns", async () => {
  const fx = fixture("a1");
  writeFrontmatter(fx.story, { cycles: "subagents", agent: "n9" });
  writeFileSync(
    join(fx.worktree, ".harness", "state.md"),
    "# S1 — Demo story\n\n## Status\nimplement-done\n\n## Cycles\n- [x] Cycle 1 — Reads: test → change\n",
    "utf8",
  );
  // a1 is a round-1 Implement agent from before the parent: same step, no cycle, no `loop-cycles`.
  const { api, created } = fakePaseo([
    { id: "a1", labels: fx.labels },
    { id: "n9", labels: { ...fx.labels, "loop-cycles": "subagents" } },
  ]);
  const turnEnded = { agent: { id: "a1" }, outcome: { kind: "completed" } } as unknown as Parameters<
    ReturnType<typeof loop>["onTurnEnded"]
  >[1];

  await loop().onTurnEnded(api, turnEnded);

  assert.equal(created.length, 0);
  assert.equal(storyMeta(fx.story).status, "implementing");
});

// A pipeline whose Implement phase has the tdd extra from a connected folder source.
function tddPipeline() {
  const source = tddSource();
  const phases = DEFAULT_PHASES.map((phase) =>
    phase.id === "implement" ? { ...phase, extras: [{ name: "tdd", source: source.id }] } : phase,
  );
  return { phases, sources: [source] };
}

// A loop that reads `pipeline` on each call, so a test can change it between steps. One agent per
// cycle, as these tests were written for.
function tddLoop(pipeline = tddPipeline()) {
  return createInitiativeLoop(
    async () => ({ ...DEFAULT_LOOP_CONFIG, subagentCycles: false }),
    async () => FALLBACK_AGENT_CONFIG,
    async () => pipeline,
  );
}

test("an Implement step copies its extras into the worktree and names them in the prompt", async () => {
  const { story, worktree, api, created, turnEnded } = planDone();
  const initiative = tddLoop();

  await initiative.onTurnEnded(api, turnEnded("a1"));

  assert.deepEqual(created.map((agent) => [agent.labels["loop-step"], agent.labels["loop-cycle"]]), [["implement", "1"]]);
  assert.ok(existsSync(join(worktree, ".claude", "skills", "tdd", "SKILL.md")), "expected .claude/skills/tdd/SKILL.md");
  assert.ok(created[0].prompt?.includes("Also use these skills: tdd (.agents/skills/tdd/SKILL.md)."), created[0].prompt);
  assert.equal(storyMeta(story).step_skills, "tdd (.agents/skills/tdd/SKILL.md)");
});

test("a resumed Implement agent gets the first prompt's skills line even after the phase drops the extra", async () => {
  const { api, created, turnEnded } = planDone();
  const pipeline = tddPipeline();
  const initiative = tddLoop(pipeline);
  await initiative.onTurnEnded(api, turnEnded("a1"));
  pipeline.phases = DEFAULT_PHASES;

  const prompt = await initiative.resumePrompt(created[0].labels);

  assert.ok(prompt?.includes("Also use these skills: tdd (.agents/skills/tdd/SKILL.md)."), prompt ?? "no resume prompt");
});

test("a resumed Implement agent whose story has no step_skills gets the looked-up paths", async () => {
  const { story, api, created, turnEnded } = planDone();
  const initiative = tddLoop();
  await initiative.onTurnEnded(api, turnEnded("a1"));
  writeFrontmatter(story, { step_skills: null });

  const prompt = await initiative.resumePrompt(created[0].labels);

  assert.equal(storyMeta(story).step_skills, undefined);
  assert.ok(prompt?.includes("Also use these skills: tdd (.agents/skills/tdd/SKILL.md)."), prompt ?? "no resume prompt");
});

test("a skill copy that throws doesn't stop the step; its error goes on the story", async () => {
  const { story, worktree, api, created, turnEnded } = planDone();
  // A file where the .claude folder should be, so creating .claude/skills fails mid-copy.
  writeFileSync(join(worktree, ".claude"), "", "utf8");
  const initiative = tddLoop();

  await initiative.onTurnEnded(api, turnEnded("a1"));

  assert.deepEqual(created.map((agent) => agent.labels["loop-step"]), ["implement"]);
  assert.match(storyMeta(story).skill_warnings ?? "", /^skills: /);
  assert.ok(created[0].prompt?.includes("Also use these skills: tdd."), created[0].prompt);
});

test("a skill warning doesn't stop the step; it goes on the story until a clean step start clears it", async () => {
  const { story, worktree, api, created, turnEnded } = planDone();
  const phases = DEFAULT_PHASES.map((phase) =>
    phase.id === "implement" ? { ...phase, extras: [{ name: "tdd", source: "gone" }] } : phase,
  );
  const initiative = createInitiativeLoop(
    async () => DEFAULT_LOOP_CONFIG,
    async () => FALLBACK_AGENT_CONFIG,
    async () => ({ phases, sources: [] }),
  );

  await initiative.onTurnEnded(api, turnEnded("a1"));

  assert.deepEqual(created.map((agent) => agent.labels["loop-step"]), ["implement"]);
  assert.equal(storyMeta(story).skill_warnings, 'tdd: source "gone" is not connected or is off.');

  writeFileSync(join(worktree, ".harness", "state.md"), "# S1 — Demo story\n\n## Status\nimplement-done\n", "utf8");
  await initiative.onTurnEnded(api, turnEnded("n1"));

  assert.deepEqual(created.map((agent) => agent.labels["loop-step"]), ["implement", "review"]);
  assert.equal(storyMeta(story).skill_warnings, undefined);
});

test("an unreadable pipeline doesn't stop the step; its error goes on the story", async () => {
  const { story, api, created, turnEnded } = planDone();
  const initiative = createInitiativeLoop(
    async () => DEFAULT_LOOP_CONFIG,
    async () => FALLBACK_AGENT_CONFIG,
    async () => {
      throw new Error("settings unreadable");
    },
  );

  await initiative.onTurnEnded(api, turnEnded("a1"));

  assert.deepEqual(created.map((agent) => agent.labels["loop-step"]), ["implement"]);
  assert.match(storyMeta(story).skill_warnings ?? "", /settings unreadable/);
});
