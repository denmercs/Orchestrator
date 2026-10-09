import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
// gh answers `pr view` with whatever ghPr() last set, and fails when nothing is set.
const ghReply = join(home, "gh-reply.json");
process.env.GH_BIN = join(home, "gh");
writeFileSync(process.env.GH_BIN, `#!/bin/sh\n[ -f "${ghReply}" ] && cat "${ghReply}" || exit 1\n`, "utf8");
chmodSync(process.env.GH_BIN, 0o755);
const ghPr = (state: string | null) => {
  if (state) writeFileSync(ghReply, JSON.stringify({ number: 45, url: "https://pr/45", state, headRefOid: "abc" }), "utf8");
  else rmSync(ghReply, { force: true });
};
const { createInitiativeLoop, RESUME_LINE, RESTART_LINE, nudgePrompt } = await import("./initiative-loop");

type PaseoApi = PluginHandlerContext["paseo"];
type Agent = {
  id: string;
  labels: Record<string, string>;
  status?: string;
  lastError?: string;
  archivedAt?: string;
};

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

// A fake Paseo: live agents by id; workspace creates are recorded and become live agents, and
// follow-ups are recorded in `sent`.
function fakePaseo(live: Agent[]) {
  const sent: { id: string; text: string }[] = [];
  const archived: string[] = [];
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
          return found ? { agent: { status: "idle", ...found } } : null;
        },
        send: async (text: string) => {
          sent.push({ id, text });
        },
      }),
      list: async () => ({ entries: live.map((agent) => ({ agent })) }),
    },
    workspaces: {
      archive: async (workspace: string) => {
        archived.push(workspace);
      },
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
  return { api: api as unknown as PaseoApi, created, sent, archived };
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

// Fakes the turn end of the story's Diagnose agent a1 with `## Status` set to `status`.
function diagnoseEnded(status: string) {
  const fx = planDone();
  writeFrontmatter(fx.story, { step: "diagnose" });
  writeFileSync(
    join(fx.worktree, ".harness", "state.md"),
    `# S1 — Demo story\n\n## Status\n${status}\n\n## Cycles\n- [ ] Cycle 1 — Reproduces: failing regression test → fix\n`,
    "utf8",
  );
  const { api, created } = fakePaseo([{ id: "a1", labels: { ...fx.labels, "loop-step": "diagnose" } }]);
  return { ...fx, api, created };
}

test("diagnose-done starts one Implement agent with no approval gate", async () => {
  const fx = diagnoseEnded("diagnose-done");

  await loop().onTurnEnded(fx.api, fx.turnEnded("a1"));

  assert.deepEqual(fx.created.map((agent) => agent.labels["loop-step"]), ["implement"]);
  assert.equal(storyMeta(fx.story).status, "implementing");
});

test("a Diagnose turn that ends without a marker is stalled, not awaiting approval", async () => {
  const fx = diagnoseEnded("diagnose-running");

  await loop().onTurnEnded(fx.api, fx.turnEnded("a1"));

  assert.equal(fx.created.length, 0);
  assert.equal(storyMeta(fx.story).status, "planning");
  assert.equal(storyMeta(fx.story).stalled, "It ended its turn without writing the step's marker.");
});

test("diagnose-blocked blocks the story with its reason", async () => {
  const fx = diagnoseEnded("diagnose-blocked\nCannot reproduce on main.");

  await loop().onTurnEnded(fx.api, fx.turnEnded("a1"));

  assert.equal(fx.created.length, 0);
  assert.equal(storyMeta(fx.story).status, "blocked");
  assert.equal(storyMeta(fx.story).blocked_reason, "Cannot reproduce on main.");
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

  assert.equal(done.git("log", "--format=%s"), "Demo story");
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

  assert.equal(git("log", "--format=%s"), "Reads");
  assert.deepEqual(
    created.map((agent) => [agent.labels["loop-cycle"], agent.labels["loop-cycles"]]),
    [[undefined, "subagents"]],
  );
  assert.match(created[0].prompt ?? "", /## Cycles to run\n- \[ \] Cycle 2 — Warns.*\n- \[ \] Cycle 3 — Resets/);
  assert.equal(storyMeta(fx.story).cycles, "subagents");
});

// A finished step in a fresh worktree repo with `## Status` set to `status`; returns the worktree's last commit subject.
async function commitAfter(step: string, status: string, frontmatter: Record<string, string | number | null>, labels: Record<string, string>) {
  const fx = fixture("a1");
  writeFrontmatter(fx.story, frontmatter);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fx.worktree, encoding: "utf8" }).trim();
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  // A bare origin the fix push can reach.
  const origin = join(fx.root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", origin]);
  git("remote", "add", "origin", origin);
  git("commit", "-q", "--allow-empty", "-m", "start");
  git("push", "-q", "-u", "origin", "HEAD");
  writeFileSync(join(fx.worktree, "meter.ts"), "export const meter = 1;\n", "utf8");
  writeFileSync(
    join(fx.worktree, ".harness", "state.md"),
    `# S1 — Demo story\n\n## Status\n${status}\n\n## Cycles\n- [x] Cycle 1 — Reads: test → change\n- [ ] Cycle 2 — Warns: warning test → warn once\n`,
    "utf8",
  );
  const { api } = fakePaseo([{ id: "a1", labels: { ...fx.labels, "loop-step": step, ...labels } }]);
  const turnEnded = { agent: { id: "a1" }, outcome: { kind: "completed" } } as unknown as Parameters<
    ReturnType<typeof loop>["onTurnEnded"]
  >[1];
  await loop().onTurnEnded(api, turnEnded);
  return { subject: git("log", "-1", "--format=%s"), meta: storyMeta(fx.story) };
}

test("a cycle's implement-done commits with the agent's subject, cleaned; without one, the cycle name", async () => {
  const given = await commitAfter("implement", "implement-done\nS1: Read the meter from settings", { cycle: 1 }, { "loop-cycle": "1" });
  assert.equal(given.subject, "Read the meter from settings");

  const none = await commitAfter("implement", "implement-done", { cycle: 1 }, { "loop-cycle": "1" });
  assert.equal(none.subject, "Reads");
});

test("a Fix CI agent's fix-done commits with its subject; without one, 'Fix failing CI checks'", async () => {
  const given = await commitAfter("fix", "fix-done\nS1: Wait for the meter before reading it", { status: "pr-open", step: "pr" }, {});
  assert.equal(given.subject, "Wait for the meter before reading it");
  assert.equal(given.meta.status, "pr-open");

  const none = await commitAfter("fix", "fix-done", { status: "pr-open", step: "pr" }, {});
  assert.equal(none.subject, "Fix failing CI checks");
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

type TurnEnded = Parameters<ReturnType<typeof loop>["onTurnEnded"]>[1];
const ended = (id: string, outcome: Record<string, unknown>) => ({ agent: { id }, outcome }) as unknown as TurnEnded;

test("a failed turn marks the step stalled; the tick nudges that session once and counts a retry", async () => {
  const { story, labels } = fixture("a1");
  const { api, created, sent } = fakePaseo([{ id: "a1", labels }]);
  const initiative = loop();

  await initiative.onTurnEnded(api, ended("a1", { kind: "failed", error: { message: "rate limited" } }));
  assert.equal(storyMeta(story).stalled, "Its last turn failed: rate limited");
  assert.deepEqual(sent, [], "the turn end itself sends nothing; the tick does");

  await initiative.tick();
  await initiative.tick();

  assert.deepEqual(sent, [{ id: "a1", text: nudgePrompt("Its last turn failed: rate limited") }]);
  assert.deepEqual(created, []);
  assert.equal(storyMeta(story).retries, "1");
  assert.equal(storyMeta(story).stalled, undefined);
  assert.equal(storyMeta(story).status, "implementing");
});

test("a turn that ends without the step's marker is nudged by the tick", async () => {
  const { story, labels } = fixture("a1");
  const { api, sent } = fakePaseo([{ id: "a1", labels }]);
  const initiative = loop();

  await initiative.onTurnEnded(api, ended("a1", { kind: "completed" }));
  await initiative.tick();

  assert.deepEqual(sent.map((item) => item.id), ["a1"]);
  assert.match(sent[0].text, /^It ended its turn without writing the step's marker\./);
  assert.equal(storyMeta(story).retries, "1");
});

test("a turn you cancel is left alone", async () => {
  const { story, labels } = fixture("a1");
  const { api, created, sent } = fakePaseo([{ id: "a1", labels }]);
  const initiative = loop();

  await initiative.onTurnEnded(api, ended("a1", { kind: "canceled", reason: "user" }));
  await initiative.tick();

  assert.equal(storyMeta(story).stalled, undefined);
  assert.deepEqual([sent, created], [[], []]);
});

test("a closed session is replaced by a fresh one on the same step that resumes from state.md", async () => {
  const { story, labels } = fixture("a1");
  const { api, created, sent } = fakePaseo([{ id: "a1", labels, status: "closed" }]);
  const initiative = loop();
  initiative.rememberPaseo(api);

  await initiative.tick();
  await initiative.tick();

  assert.deepEqual(
    created.map((agent) => [agent.labels["loop-step"], agent.labels["loop-round"], agent.labels["loop-attempt"]]),
    [["implement", "1", "1"]],
  );
  assert.ok(created[0].prompt?.endsWith(`\n\n${RESTART_LINE}`), created[0].prompt);
  assert.deepEqual(sent, []);
  assert.equal(storyMeta(story).agent, "n1");
  assert.equal(storyMeta(story).retries, "1");
});

test("a session Paseo no longer knows is replaced too", async () => {
  const { story } = fixture("gone");
  const { api, created } = fakePaseo([]);
  const initiative = loop();
  initiative.rememberPaseo(api);

  await initiative.tick();

  assert.deepEqual(created.map((agent) => agent.labels["loop-step"]), ["implement"]);
  assert.equal(storyMeta(story).agent, "n1");
});

test("past maxRetries the story blocks with the reason instead of retrying", async () => {
  const { story, labels } = fixture("a1");
  writeFrontmatter(story, { retries: 2 });
  const { api, created, sent } = fakePaseo([{ id: "a1", labels, status: "error", lastError: "provider crashed" }]);
  const initiative = loop();
  initiative.rememberPaseo(api);

  await initiative.tick();

  assert.deepEqual([sent, created], [[], []]);
  assert.equal(storyMeta(story).status, "blocked");
  assert.equal(storyMeta(story).blocked_reason, "Implement: Its session failed: provider crashed. Gave up after 2 retries.");
  assert.equal(storyMeta(story).blocked_from, "implementing");
});

test("a running session, or a Paseo that doesn't answer, is left alone", async () => {
  const { story, labels } = fixture("a1");
  writeFrontmatter(story, { stalled: "Its last turn failed: boom" });
  const { api, created, sent } = fakePaseo([{ id: "a1", labels, status: "running" }]);
  const initiative = loop();
  initiative.rememberPaseo(api);
  await initiative.tick();

  const silent = fakePaseo([]);
  (silent.api.agents as unknown as { ref: unknown }).ref = () => ({
    refresh: async () => {
      throw new Error("daemon unreachable");
    },
  });
  initiative.rememberPaseo(silent.api);
  await initiative.tick();

  assert.deepEqual([sent, created, silent.sent, silent.created], [[], [], [], []]);
  assert.equal(storyMeta(story).status, "implementing");
});

test("a permission request blocks the story and keeps its slot; answering it puts the story back", async () => {
  const { story, labels } = fixture("a1");
  const { api } = fakePaseo([{ id: "a1", labels }, { id: "other", labels: { ...labels, "loop-step": "review" } }]);
  const initiative = loop();
  const request = { name: "Bash", title: "Run npm install" };

  await initiative.onPermissionRequested(api, { agent: { id: "other" }, request } as never);
  assert.equal(storyMeta(story).status, "implementing", "only the story's current session counts");

  // A ready second story: with one slot, it must wait while S1's session is still open.
  writeFileSync(join(dirname(story), "02-next.md"), "---\nid: S2\ntitle: Next\nstatus: todo\n---\n", "utf8");
  await initiative.onPermissionRequested(api, { agent: { id: "a1" }, request } as never);
  await initiative.tick();
  assert.equal(storyMeta(join(dirname(story), "02-next.md")).status, "todo", "S2 was picked up while S1 held the slot");
  assert.equal(storyMeta(story).status, "blocked");
  assert.equal(storyMeta(story).blocked_reason, "Waiting on permission: Run npm install. Answer it in the session.");
  assert.equal(storyMeta(story).waiting_on, "permission");

  await initiative.onPermissionResolved(api, { agent: { id: "a1" } } as never);
  const meta = storyMeta(story);
  assert.deepEqual(
    [meta.status, meta.blocked_reason, meta.blocked_from, meta.waiting_on],
    ["implementing", undefined, undefined, undefined],
  );
});

test("a dead subagent-cycles parent comes back as a parent with only the open cycles", async () => {
  const { story, worktree, labels } = fixture("a1");
  writeFrontmatter(story, { cycles: "subagents" });
  writeFileSync(
    join(worktree, ".harness", "state.md"),
    "# S1 — Demo story\n\n## Status\nimplement-running\n\n## Cycles\n- [x] Cycle 1 — Reads: test → change\n- [ ] Cycle 2 — Warns: warning test → warn once\n",
    "utf8",
  );
  const { api, created } = fakePaseo([{ id: "a1", labels: { ...labels, "loop-cycles": "subagents" }, status: "closed" }]);
  const initiative = loop();
  initiative.rememberPaseo(api);

  await initiative.tick();

  assert.deepEqual(
    created.map((agent) => [agent.labels["loop-cycles"], agent.labels["loop-attempt"], agent.labels["loop-cycle"]]),
    [["subagents", "1", undefined]],
  );
  assert.match(created[0].prompt ?? "", /Cycle 2 — Warns/);
  assert.doesNotMatch(created[0].prompt ?? "", /Cycle 1 — Reads/);
  assert.equal(storyMeta(story).cycles, "subagents");
});

test("a step whose worktree is gone and whose PR merged is recorded merged and its workspace archived", async (t) => {
  t.after(() => ghPr(null));
  const { story, worktree, labels } = fixture("a1");
  rmSync(worktree, { recursive: true });
  ghPr("MERGED");
  const { api, created, sent, archived } = fakePaseo([{ id: "a1", labels }]);
  const initiative = loop();
  initiative.rememberPaseo(api);

  await initiative.tick();

  const meta = storyMeta(story);
  assert.deepEqual([meta.status, meta.pr, meta.agent], ["merged", "45", undefined]);
  assert.deepEqual(archived, ["ws1"]);
  assert.deepEqual([created, sent], [[], []]);
});

test("a step whose worktree is gone with an open PR is handed to the PR watcher", async (t) => {
  t.after(() => ghPr(null));
  const { story, worktree, labels } = fixture("a1");
  rmSync(worktree, { recursive: true });
  ghPr("OPEN");
  const { api, created } = fakePaseo([{ id: "a1", labels }]);
  const initiative = loop();
  initiative.rememberPaseo(api);

  await initiative.tick();

  const meta = storyMeta(story);
  assert.deepEqual([meta.status, meta.step, meta.pr, meta.ci], ["pr-open", "pr", "45", "none"]);
  assert.deepEqual(created, []);
});

test("a step whose worktree is gone with a closed PR blocks", async (t) => {
  t.after(() => ghPr(null));
  const { story, worktree, labels } = fixture("a1");
  rmSync(worktree, { recursive: true });
  ghPr("CLOSED");
  const { api } = fakePaseo([{ id: "a1", labels }]);
  const initiative = loop();
  initiative.rememberPaseo(api);

  await initiative.tick();

  assert.equal(storyMeta(story).status, "blocked");
  assert.equal(storyMeta(story).blocked_reason, "Its worktree is gone and PR #45 was closed without merging.");
});

test("a step whose worktree is gone with no PR retries, then blocks past maxRetries", async () => {
  const { story, worktree, labels } = fixture("a1");
  rmSync(worktree, { recursive: true });
  const { api, created } = fakePaseo([{ id: "a1", labels }]);
  const initiative = loop();
  initiative.rememberPaseo(api);

  for (let tick = 0; tick < DEFAULT_LOOP_CONFIG.maxRetries; tick++) await initiative.tick();
  assert.equal(storyMeta(story).status, "implementing");
  assert.equal(storyMeta(story).retries, String(DEFAULT_LOOP_CONFIG.maxRetries));

  await initiative.tick();
  assert.equal(storyMeta(story).status, "blocked");
  assert.equal(storyMeta(story).blocked_reason, "Its worktree is gone and feature/s1 has no PR.");
  assert.deepEqual(created, []);
});

// A repo with a todo story and the loop on; Start creates its workspace through a fake Paseo that
// records the branch it was asked for.
async function startNewStory(options: { branch?: string; existing?: string[]; frontmatter?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loop-start-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("commit", "-q", "--allow-empty", "-m", "init");
  for (const name of options.existing ?? []) git("branch", name);
  const init = join(root, ".harness", "initiatives", "demo");
  const phase = join(init, "phases", "1-meter");
  mkdirSync(join(phase, "stories"), { recursive: true });
  writeFileSync(join(init, "initiative.md"), "---\nloop: on\n---\n# Initiative: Demo\n", "utf8");
  writeFileSync(join(phase, "phase.md"), "---\nphase: 1\ntitle: Meter\n---\n", "utf8");
  const story = join(phase, "stories", "01-story.md");
  const saved = options.branch ? `branch: ${options.branch}\n` : "";
  const extra = options.frontmatter ?? "";
  writeFileSync(story, `---\nid: S1\ntitle: Add search\nstatus: todo\n${saved}${extra}---\n\n## Goal\n\nShip it.\n`, "utf8");
  const fake = fakePaseo([]);
  const requested: string[] = [];
  const api = fake.api as unknown as Record<string, unknown> & { workspaces: Record<string, unknown> };
  api.projects = { list: async () => ({ projects: [] }) };
  api.workspaces.create = async (input: { source: { branchName: string } }) => {
    requested.push(input.source.branchName);
    const directory = join(root, "wt");
    mkdirSync(directory, { recursive: true });
    return { id: "ws-new", directory };
  };
  const initiative = createInitiativeLoop(
    async () => DEFAULT_LOOP_CONFIG,
    async () => FALLBACK_AGENT_CONFIG,
    noExtras,
    async () => "dm",
  );
  const result = await initiative.start(fake.api, { repo: root, initiative: "demo" });
  assert.equal(result.error, null);
  return { requested, meta: storyMeta(story), created: fake.created };
}

test("a new story's branch is <initials>/<title slug>", async () => {
  const { requested, meta } = await startNewStory();
  assert.deepEqual(requested, ["dm/add-search"]);
  assert.equal(meta.branch, "dm/add-search");
});

test("a new story's branch gets -2 when that branch already exists", async () => {
  const { requested } = await startNewStory({ existing: ["dm/add-search"] });
  assert.deepEqual(requested, ["dm/add-search-2"]);
});

test("a track: diagnose story starts on Diagnose with its Jira key and link", async () => {
  const url = "https://x.atlassian.net/browse/BUG-7";
  const { created, meta } = await startNewStory({ frontmatter: `track: diagnose\njira: BUG-7\njira_url: ${url}\n` });
  assert.equal(created.length, 1);
  assert.equal(created[0].labels["loop-step"], "diagnose");
  assert.match(created[0].title, /Diagnose/);
  assert.equal(meta.status, "planning");
  assert.equal(meta.step, "diagnose");
  assert.ok(created[0].prompt?.includes("BUG-7"), created[0].prompt);
  assert.ok(created[0].prompt?.includes(url), created[0].prompt);
});

test("a story without a track starts on Plan", async () => {
  const { created } = await startNewStory();
  assert.equal(created.length, 1);
  assert.equal(created[0].labels["loop-step"], "plan");
});

test("a saved branch: still wins over the generated name", async () => {
  const { requested } = await startNewStory({ branch: "feature/kept" });
  assert.deepEqual(requested, ["feature/kept"]);
});

test("a start that fails after Paseo made the branch keeps that branch for the retry", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loop-retry-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("commit", "-q", "--allow-empty", "-m", "init");
  const init = join(root, ".harness", "initiatives", "demo");
  const phase = join(init, "phases", "1-meter");
  mkdirSync(join(phase, "stories"), { recursive: true });
  writeFileSync(join(init, "initiative.md"), "---\nloop: on\n---\n# Initiative: Demo\n", "utf8");
  writeFileSync(join(phase, "phase.md"), "---\nphase: 1\ntitle: Meter\n---\n", "utf8");
  const story = join(phase, "stories", "01-story.md");
  writeFileSync(story, "---\nid: S1\ntitle: Add search\nstatus: todo\n---\n\n## Goal\n\nShip it.\n", "utf8");
  const fake = fakePaseo([]);
  const requested: string[] = [];
  const api = fake.api as unknown as Record<string, unknown> & { workspaces: Record<string, unknown> };
  api.projects = { list: async () => ({ projects: [] }) };
  api.workspaces.create = async (input: { source: { branchName: string } }) => {
    requested.push(input.source.branchName);
    if (requested.length === 1) {
      // Paseo branched off, then failed before reporting the workspace.
      git("branch", input.source.branchName);
      throw new Error("Paseo created the workspace but did not report its folder.");
    }
    const directory = join(root, "wt");
    mkdirSync(directory, { recursive: true });
    return { id: "ws-new", directory };
  };
  const initiative = createInitiativeLoop(
    async () => DEFAULT_LOOP_CONFIG,
    async () => FALLBACK_AGENT_CONFIG,
    noExtras,
    async () => "dm",
  );

  await initiative.start(fake.api, { repo: root, initiative: "demo" });
  assert.equal(storyMeta(story).status, "blocked");
  writeFrontmatter(story, { status: "todo", blocked_reason: null });
  await initiative.start(fake.api, { repo: root, initiative: "demo" });

  assert.deepEqual(requested, ["dm/add-search", "dm/add-search"]);
  assert.equal(storyMeta(story).branch, "dm/add-search");
});

test("gateStory finds a story in any phase by its id, and is null when it isn't there", async () => {
  const { root } = fixture("a1");
  const later = join(root, ".harness", "initiatives", "demo", "phases", "2-later", "stories");
  mkdirSync(later, { recursive: true });
  writeFileSync(join(later, "01-wait.md"), "---\nid: S2\ntitle: Wait\nstatus: blocked\nwaiting_on: permission\n---\n", "utf8");
  const initiative = loop();
  const ref = (storyId: string, slug = "demo") => ({ repo: root, initiative: slug, storyId });

  assert.deepEqual(
    [await initiative.gateStory(ref("S1")), await initiative.gateStory(ref("S2"))],
    [
      { status: "implementing", agent: "a1", waitingOn: null },
      { status: "blocked", agent: null, waitingOn: "permission" },
    ],
  );
  assert.deepEqual([await initiative.gateStory(ref("S9")), await initiative.gateStory(ref("S1", "nope"))], [null, null]);
});

test("reopen puts a blocked story back on blocked_from with the block fields cleared; anything else is left alone", async () => {
  const { root, story } = fixture("a1");
  writeFrontmatter(story, {
    status: "blocked",
    blocked_reason: "Implement: stuck. Gave up after 2 retries.",
    blocked_from: "implementing",
    stalled: "Its last turn failed: boom",
    retries: 2,
  });
  const initiative = loop();
  const ref = { repo: root, initiative: "demo", storyId: "S1" };

  await initiative.reopen(ref);
  const meta = storyMeta(story);
  assert.deepEqual(
    [meta.status, meta.blocked_reason, meta.blocked_from, meta.stalled, meta.retries, meta.agent],
    ["implementing", undefined, undefined, undefined, undefined, "a1"],
  );

  // Not blocked any more, or blocked with nowhere to go back to: nothing changes.
  const reopened = readFileSync(story, "utf8");
  await initiative.reopen(ref);
  assert.equal(readFileSync(story, "utf8"), reopened);
  writeFrontmatter(story, { status: "blocked", retries: 1 });
  const noFrom = readFileSync(story, "utf8");
  await initiative.reopen(ref);
  await initiative.reopen({ ...ref, storyId: "S9" });
  assert.equal(readFileSync(story, "utf8"), noFrom);
});
