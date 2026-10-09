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
import { readMarker } from "../shared/story-method";
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
const ghPr = (state: string | null, statusCheckRollup: unknown[] = []) => {
  if (state) writeFileSync(ghReply, JSON.stringify({ number: 45, url: "https://pr/45", state, headRefOid: "abc", statusCheckRollup }), "utf8");
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
  assert.equal(storyMeta(fx.story).block_kind, "step");
});

test("a Diagnose blocked by the retry limit that then writes diagnose-done is resumed and starts Implement", async () => {
  const fx = diagnoseEnded("diagnose-done");
  writeFrontmatter(fx.story, { status: "blocked", blocked_from: "planning", block_kind: "retry-limit", retries: 2 });

  await loop().onTurnEnded(fx.api, fx.turnEnded("a1"));

  assert.deepEqual(fx.created.map((agent) => agent.labels["loop-step"]), ["implement"]);
  assert.deepEqual([storyMeta(fx.story).status, storyMeta(fx.story).block_kind], ["implementing", undefined]);
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
  assert.equal(storyMeta(open.story).block_kind, "step");
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

test("review-done on a branch with no commits over its base closes the story without a PR", async () => {
  const fx = fixture("a1");
  writeFrontmatter(fx.story, { status: "reviewing", step: "review" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fx.worktree, encoding: "utf8" }).trim();
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  const origin = join(fx.root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", origin]);
  git("remote", "add", "origin", origin);
  git("checkout", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "start");
  git("push", "-q", "-u", "origin", "main");
  git("checkout", "-q", "-b", "feature/s1");
  writeFileSync(join(fx.worktree, ".harness", "state.md"), "# S1 — Demo story\n\n## Status\nreview-done\n", "utf8");
  const { api } = fakePaseo([{ id: "a1", labels: { ...fx.labels, "loop-step": "review" } }]);
  const turnEnded = { agent: { id: "a1" }, outcome: { kind: "completed" } } as unknown as Parameters<
    ReturnType<typeof loop>["onTurnEnded"]
  >[1];

  await loop().onTurnEnded(api, turnEnded);

  const meta = storyMeta(fx.story);
  assert.deepEqual([meta.status, meta.pr, meta.blocked_reason], ["merged", undefined, undefined]);
  assert.match(readFileSync(fx.story, "utf8"), /### Nothing to ship/);
  assert.equal(git("ls-remote", "--heads", "origin", "feature/s1"), "");
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

const limitMessage = (resets: Date) => `Claude AI usage limit reached|${Math.floor(resets.getTime() / 1000)}`;

test("a turn that hit the usage limit pauses the story until the reset: no nudge, no retry, no new story", async () => {
  const { story, labels } = fixture("a1");
  const { api, created, sent } = fakePaseo([{ id: "a1", labels }]);
  const initiative = loop();

  await initiative.onTurnEnded(api, ended("a1", { kind: "failed", error: { message: limitMessage(new Date(Date.now() + 3_600_000)) } }));
  assert.equal(storyMeta(story).stalled, undefined);
  assert.ok(Date.parse(storyMeta(story).paused_until ?? "") > Date.now());

  await initiative.tick();
  await initiative.tick();

  assert.deepEqual([sent, created], [[], []]);
  assert.equal(storyMeta(story).retries, undefined);
  assert.equal(storyMeta(story).status, "implementing");
});

test("once the reset has passed, the tick nudges the paused session without counting a retry", async () => {
  const { story, labels } = fixture("a1");
  writeFrontmatter(story, { retries: 1, paused_until: new Date(Date.now() - 1000).toISOString() });
  const { api, created, sent } = fakePaseo([{ id: "a1", labels }]);
  const initiative = loop();
  initiative.rememberPaseo(api);

  await initiative.tick();
  await initiative.tick();

  assert.deepEqual(sent, [{ id: "a1", text: nudgePrompt("The usage limit has reset.") }]);
  assert.deepEqual(created, []);
  assert.equal(storyMeta(story).paused_until, undefined);
  assert.equal(storyMeta(story).retries, "1");
});

test("a paused story at maxRetries still resumes: the pause isn't a retry", async () => {
  const { story, labels } = fixture("a1");
  writeFrontmatter(story, { retries: 2, paused_until: new Date(Date.now() - 1000).toISOString() });
  const { api, sent } = fakePaseo([{ id: "a1", labels }]);
  const initiative = loop();
  initiative.rememberPaseo(api);

  await initiative.tick();

  assert.equal(sent.length, 1);
  assert.equal(storyMeta(story).status, "implementing");
});

test("a pause that ended inside the hold window waits for the window to close", async () => {
  const { story, labels } = fixture("a1");
  writeFrontmatter(story, { paused_until: new Date(Date.now() - 1000).toISOString() });
  const { api, sent } = fakePaseo([{ id: "a1", labels }]);
  const hour = new Date().getHours();
  const holding = createInitiativeLoop(
    async () => ({ ...DEFAULT_LOOP_CONFIG, holdFrom: hour, holdUntil: (hour + 2) % 24 }),
    async () => FALLBACK_AGENT_CONFIG,
    noExtras,
  );
  holding.rememberPaseo(api);

  await holding.tick();
  assert.deepEqual(sent, []);
  assert.ok(storyMeta(story).paused_until);

  const open = createInitiativeLoop(
    async () => ({ ...DEFAULT_LOOP_CONFIG, holdFrom: (hour + 1) % 24, holdUntil: (hour + 2) % 24 }),
    async () => FALLBACK_AGENT_CONFIG,
    noExtras,
  );
  open.rememberPaseo(api);
  await open.tick();
  assert.equal(sent.length, 1);
});

test("inside the hold window no new story starts, while a step already running is left alone", async () => {
  const { story, labels } = fixture("a1");
  const second = join(dirname(story), "02-next.md");
  writeFileSync(second, "---\nid: S2\ntitle: Next\nstatus: todo\n---\n\n## Goal\n\nLater.\n", "utf8");
  const { api, created } = fakePaseo([{ id: "a1", labels, status: "running" }]);
  const hour = new Date().getHours();
  const holding = createInitiativeLoop(
    async () => ({ ...DEFAULT_LOOP_CONFIG, parallel: 2, holdFrom: hour, holdUntil: (hour + 2) % 24 }),
    async () => FALLBACK_AGENT_CONFIG,
    noExtras,
  );
  holding.rememberPaseo(api);

  await holding.tick();

  assert.deepEqual(created, []);
  assert.equal(storyMeta(second).status, "todo");
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

test("a step blocked by the retry limit that then writes implement-done is resumed, committed and moved to Review", async () => {
  const { story, worktree, labels } = fixture("a1");
  writeFrontmatter(story, { retries: 2, stalled: "Its last turn failed: rate limited" });
  const { api, created, sent } = fakePaseo([{ id: "a1", labels }]);
  const initiative = loop();
  initiative.rememberPaseo(api);

  await initiative.tick();
  assert.deepEqual([sent, created], [[], []]);
  assert.equal(storyMeta(story).status, "blocked");
  assert.equal(storyMeta(story).blocked_reason, "Implement: Its last turn failed: rate limited Gave up after 2 retries.");
  assert.equal(storyMeta(story).block_kind, "retry-limit");

  // The session was still working: its answer lands after the loop gave up.
  const git = (...args: string[]) => execFileSync("git", args, { cwd: worktree, encoding: "utf8" }).trim();
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(worktree, "meter.ts"), "export const meter = 1;\n", "utf8");
  writeFileSync(join(worktree, ".harness", "state.md"), "# S1 — Demo story\n\n## Status\nimplement-done\n", "utf8");
  await initiative.onTurnEnded(api, { agent: { id: "a1" }, outcome: { kind: "completed" } } as never);

  assert.equal(git("log", "--format=%s"), "Demo story");
  assert.deepEqual(created.map((agent) => agent.labels["loop-step"]), ["review"]);
  const meta = storyMeta(story);
  assert.deepEqual(
    [meta.status, meta.blocked_reason, meta.blocked_from, meta.retries, meta.stalled, meta.block_kind],
    ["reviewing", undefined, undefined, undefined, undefined, undefined],
  );
});

test("a retry-limit block stays blocked when state.md holds no answer from the step", async () => {
  const { story, worktree, labels } = fixture("a1");
  writeFrontmatter(story, { retries: 2, stalled: "Its last turn failed: rate limited" });
  const { api, created, sent } = fakePaseo([{ id: "a1", labels }]);
  const initiative = loop();
  initiative.rememberPaseo(api);

  await initiative.tick();
  const reason = storyMeta(story).blocked_reason;
  for (const status of ["", "something-else"]) {
    writeFileSync(join(worktree, ".harness", "state.md"), `# S1 — Demo story\n\n## Status\n${status}\n`, "utf8");
    await initiative.onTurnEnded(api, { agent: { id: "a1" }, outcome: { kind: "completed" } } as never);
    await initiative.tick();

    assert.deepEqual([sent, created], [[], []]);
    assert.deepEqual([storyMeta(story).status, storyMeta(story).blocked_reason], ["blocked", reason], `marker "${status}"`);
  }
});

test("a permission block with implement-done in state.md stays blocked through a turn end and a tick", async () => {
  const { story, worktree, labels } = fixture("a1");
  writeFrontmatter(story, { retries: 2, stalled: "Its last turn failed: rate limited" });
  const { api, created, sent } = fakePaseo([{ id: "a1", labels }]);
  const initiative = loop();
  initiative.rememberPaseo(api);

  // First a retry-limit block, then reset by hand with its kind left behind.
  await initiative.tick();
  assert.equal(storyMeta(story).block_kind, "retry-limit");
  writeFrontmatter(story, { status: "implementing", blocked_reason: null, blocked_from: null, retries: null, stalled: null });

  const request = { name: "Bash", title: "Run npm install" };
  await initiative.onPermissionRequested(api, { agent: { id: "a1" }, request } as never);
  const reason = "Waiting on permission: Run npm install. Answer it in the session.";
  assert.equal(storyMeta(story).status, "blocked");
  assert.equal(storyMeta(story).blocked_reason, reason);
  assert.equal(storyMeta(story).block_kind, undefined, "a permission block clears the retry-limit kind");

  const git = (...args: string[]) => execFileSync("git", args, { cwd: worktree, encoding: "utf8" }).trim();
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(worktree, "meter.ts"), "export const meter = 1;\n", "utf8");
  writeFileSync(join(worktree, ".harness", "state.md"), "# S1 — Demo story\n\n## Status\nimplement-done\n", "utf8");
  await initiative.onTurnEnded(api, { agent: { id: "a1" }, outcome: { kind: "completed" } } as never);
  await initiative.tick();

  assert.equal(git("rev-list", "--all"), "", "nothing was committed");
  assert.deepEqual([sent, created], [[], []]);
  assert.equal(storyMeta(story).status, "blocked");
  assert.equal(storyMeta(story).blocked_reason, reason);
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
  assert.equal(storyMeta(story).block_kind, "pr");
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
  assert.equal(storyMeta(story).block_kind, "pr");
  assert.deepEqual(created, []);
});

test("each block site writes its kind: step for a blocked or failed step, ci for the fix limit, pr for a closed PR", async (t) => {
  t.after(() => ghPr(null));
  const marker = async (status: string, step: string, round: number) => {
    const fx = fixture("a1");
    writeFrontmatter(fx.story, { step, round, status: step === "review" ? "reviewing" : "implementing" });
    writeFileSync(join(fx.worktree, ".harness", "state.md"), `# S1 — Demo story\n\n## Status\n${status}\n`, "utf8");
    const labels = { ...fx.labels, "loop-step": step, "loop-round": String(round) };
    const { api } = fakePaseo([{ id: "a1", labels }]);
    await loop().onTurnEnded(api, ended("a1", { kind: "completed" }));
    return storyMeta(fx.story);
  };
  const blocked = await marker("implement-blocked\nNeeds a key.", "implement", 1);
  assert.deepEqual([blocked.status, blocked.block_kind], ["blocked", "step"]);
  const failed = await marker("review-failed", "review", DEFAULT_LOOP_CONFIG.reviewRounds);
  assert.deepEqual([failed.status, failed.block_kind], ["blocked", "step"]);

  const watched = async (reply: Record<string, unknown>) => {
    const fx = fixture("a1");
    writeFrontmatter(fx.story, { status: "pr-open", step: "pr", pr: 45, ci: "failing", fix_attempts: DEFAULT_LOOP_CONFIG.maxFixes });
    writeFileSync(ghReply, JSON.stringify({ number: 45, url: "https://pr/45", headRefOid: "abc", ...reply }), "utf8");
    const { api } = fakePaseo([]);
    const initiative = loop();
    initiative.rememberPaseo(api);
    await initiative.tick();
    return storyMeta(fx.story);
  };
  const failing = { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "", completedAt: "1" };
  const ci = await watched({ state: "OPEN", statusCheckRollup: [failing] });
  assert.deepEqual([ci.status, ci.block_kind], ["blocked", "ci"]);
  const closed = await watched({ state: "CLOSED" });
  assert.deepEqual([closed.status, closed.block_kind], ["blocked", "pr"]);
});

// A repo with a todo story and the loop on; Start creates its workspace through a fake Paseo that
// records the branch it was asked for.
async function startNewStory(
  options: { branch?: string; existing?: string[]; frontmatter?: string; pipeline?: Parameters<typeof createInitiativeLoop>[2] } = {},
) {
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
    options.pipeline ?? noExtras,
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

test("a track: diagnose story starts on Diagnose with its Jira key and link and the Plan phase's extras", async () => {
  const url = "https://x.atlassian.net/browse/BUG-7";
  const source = tddSource();
  const phases = DEFAULT_PHASES.map((phase) =>
    phase.id === "plan" ? { ...phase, extras: [{ name: "tdd", source: source.id }] } : phase,
  );
  const { created, meta } = await startNewStory({
    frontmatter: `track: diagnose\njira: BUG-7\njira_url: ${url}\n`,
    pipeline: async () => ({ phases, sources: [source] }),
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].labels["loop-step"], "diagnose");
  assert.match(created[0].title, /Diagnose/);
  assert.equal(meta.status, "planning");
  assert.equal(meta.step, "diagnose");
  assert.ok(created[0].prompt?.includes("BUG-7"), created[0].prompt);
  assert.ok(created[0].prompt?.includes(url), created[0].prompt);
  assert.ok(created[0].prompt?.includes("Also use these skills: tdd"), created[0].prompt);
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
  assert.equal(storyMeta(story).block_kind, "start");
  writeFrontmatter(story, { status: "todo", blocked_reason: null });
  await initiative.start(fake.api, { repo: root, initiative: "demo" });

  assert.deepEqual(requested, ["dm/add-search", "dm/add-search"]);
  assert.equal(storyMeta(story).branch, "dm/add-search");
});

test("gateStory finds a story in any phase by its id, and is null when it isn't there", async () => {
  const { root } = fixture("a1");
  const later = join(root, ".harness", "initiatives", "demo", "phases", "2-later", "stories");
  mkdirSync(later, { recursive: true });
  writeFileSync(join(later, "01-wait.md"), "---\nid: S2\ntitle: Wait\nstatus: blocked\nwaiting_on: permission\nblock_kind: ci\n---\n", "utf8");
  const initiative = loop();
  const ref = (storyId: string, slug = "demo") => ({ repo: root, initiative: slug, storyId });

  assert.deepEqual(
    [await initiative.gateStory(ref("S1")), await initiative.gateStory(ref("S2"))],
    [
      { status: "implementing", agent: "a1", waitingOn: null, blockKind: null },
      { status: "blocked", agent: null, waitingOn: "permission", blockKind: "ci" },
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
    block_kind: "retry-limit",
    waiting_on: "permission",
  });
  const initiative = loop();
  const ref = { repo: root, initiative: "demo", storyId: "S1" };

  await initiative.reopen(ref);
  const meta = storyMeta(story);
  assert.deepEqual(
    [meta.status, meta.blocked_reason, meta.blocked_from, meta.stalled, meta.retries, meta.block_kind, meta.waiting_on, meta.agent],
    ["implementing", undefined, undefined, undefined, undefined, undefined, undefined, "a1"],
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

// What the Review agent leaves in the worktree's state.md when it fails a round.
const reviewFailed = (worktree: string) =>
  writeFileSync(
    join(worktree, ".harness", "state.md"),
    "# S1 — Demo story\n\n## Status\nreview-failed\n\n## Review findings\n* server/x.ts:12 — wrong — fix it\n- shared/y.ts:3 — bad — fix too\n",
    "utf8",
  );
const failingTest = { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "", completedAt: "2026-01-01T00:00:00Z" };
const completed = { agent: { id: "a1" }, outcome: { kind: "completed" } } as unknown as Parameters<ReturnType<typeof loop>["onTurnEnded"]>[1];

test("a failed Review round is copied into the story file with review_rounds; at the limit it is recorded before the block", async () => {
  const fx = fixture("a1");
  writeFrontmatter(fx.story, { step: "review" });
  reviewFailed(fx.worktree);
  const { api, created } = fakePaseo([{ id: "a1", labels: { ...fx.labels, "loop-step": "review" } }]);

  await loop().onTurnEnded(api, completed);

  const text = readFileSync(fx.story, "utf8");
  assert.match(text, /### Review round 1\n- server\/x\.ts:12 — wrong — fix it\n- shared\/y\.ts:3 — bad — fix too\n/);
  assert.equal(storyMeta(fx.story).review_rounds, "1");
  assert.deepEqual(created.map((agent) => agent.labels["loop-round"]), ["2"]);

  const last = fixture("a1");
  writeFrontmatter(last.story, { step: "review", round: DEFAULT_LOOP_CONFIG.reviewRounds });
  reviewFailed(last.worktree);
  const again = fakePaseo([{ id: "a1", labels: { ...last.labels, "loop-step": "review" } }]);
  await loop().onTurnEnded(again.api, completed);
  const limit = readFileSync(last.story, "utf8");
  assert.equal(storyMeta(last.story).status, "blocked");
  assert.match(limit, new RegExp(`### Review round ${DEFAULT_LOOP_CONFIG.reviewRounds}\\n- server`));
  assert.match(limit, /### Blocked\n- Review failed \d+ times/);
});

test("a PR with a failing check starts Fix CI and records the attempt and the check", async (t) => {
  t.after(() => ghPr(null));
  const fx = fixture("a1");
  writeFrontmatter(fx.story, { status: "pr-open", step: "pr", pr: 45 });
  ghPr("OPEN", [failingTest]);
  const { api, created } = fakePaseo([]);
  const initiative = loop();
  initiative.rememberPaseo(api);

  await initiative.tick();

  assert.deepEqual(created.map((agent) => agent.labels["loop-step"]), ["fix"]);
  const meta = storyMeta(fx.story);
  assert.deepEqual([meta.fix_attempts, meta.failed_checks, meta.fixed_sha], ["1", "test", "abc"]);
  assert.match(readFileSync(fx.story, "utf8"), /### CI fix attempt 1\n- failing: test\n/);
});

test("block() records its reason in the story file; a permission wait does not", async () => {
  const fx = fixture("a1");
  writeFrontmatter(fx.story, { step: "diagnose" });
  writeFileSync(join(fx.worktree, ".harness", "state.md"), "# S1\n\n## Status\ndiagnose-blocked\nCannot reproduce on main.\n", "utf8");
  const { api } = fakePaseo([{ id: "a1", labels: { ...fx.labels, "loop-step": "diagnose" } }]);
  await loop().onTurnEnded(api, completed);
  assert.match(readFileSync(fx.story, "utf8"), /### Blocked\n- Cannot reproduce on main\.\n/);

  const waiting = fixture("a1");
  const second = fakePaseo([{ id: "a1", labels: waiting.labels }]);
  await loop().onPermissionRequested(second.api, { agent: { id: "a1" }, request: { name: "Bash", title: "Run it" } } as never);
  assert.equal(storyMeta(waiting.story).status, "blocked");
  assert.doesNotMatch(readFileSync(waiting.story, "utf8"), /## Outcome/);
});

test("after merge and archive, the story file alone shows the rounds, findings, fix attempt and total", async (t) => {
  t.after(() => ghPr(null));
  const fx = fixture("a1");
  const { api, created, archived } = fakePaseo([{ id: "a1", labels: { ...fx.labels, "loop-step": "review" } }]);
  const initiative = loop();
  initiative.rememberPaseo(api);
  writeFrontmatter(fx.story, { step: "review" });
  reviewFailed(fx.worktree);
  await initiative.onTurnEnded(api, completed);
  assert.equal(created.length, 1);

  // Review passes in round 2 and the PR opens: `round` goes back to 1.
  writeFrontmatter(fx.story, { status: "pr-open", step: "pr", round: 1, pr: 45 });
  ghPr("OPEN", [failingTest]);
  await initiative.tick();
  assert.equal(created.at(-1)?.labels["loop-step"], "fix");

  writeFrontmatter(fx.story, { status: "pr-open", step: "pr" });
  rmSync(fx.worktree, { recursive: true });
  ghPr("MERGED");
  await initiative.tick();

  const text = readFileSync(fx.story, "utf8");
  const meta = storyMeta(fx.story);
  assert.deepEqual(
    [meta.status, meta.review_rounds, meta.fix_attempts, meta.failed_checks],
    ["merged", "1", "1", "test"],
  );
  assert.match(text, /### Review round 1\n- server\/x\.ts:12 — wrong — fix it/);
  assert.match(text, /### CI fix attempt 1\n- failing: test\n/);
  assert.match(text, /### Merged\n- 2 review rounds, 1 CI fix attempt\n$/);
  assert.deepEqual(archived, ["ws1"]);
});

test("reopen gives a ci block a fresh fix budget, and puts a step block's marker back to running", async () => {
  const { root, worktree, story } = fixture("a1");
  const initiative = loop();
  const ref = { repo: root, initiative: "demo", storyId: "S1" };
  const marker = () => readMarker(readFileSync(join(worktree, ".harness", "state.md"), "utf8")).marker;

  writeFrontmatter(story, {
    status: "blocked",
    blocked_reason: "CI still failing after 2 fixes.",
    blocked_from: "pr-open",
    block_kind: "ci",
    step: "pr",
    fix_attempts: 2,
    fixed_sha: "abc123",
  });
  await initiative.reopen(ref);
  let meta = storyMeta(story);
  assert.deepEqual(
    [meta.status, meta.block_kind, meta.fix_attempts, meta.fixed_sha],
    ["pr-open", undefined, undefined, undefined],
  );

  writeFileSync(join(worktree, ".harness", "state.md"), "# S1 — Demo story\n\n## Status\nreview-failed\nStill broken.\n", "utf8");
  writeFrontmatter(story, { status: "blocked", blocked_reason: "Review failed twice.", blocked_from: "reviewing", block_kind: "step", step: "review" });
  await initiative.reopen(ref);
  meta = storyMeta(story);
  assert.deepEqual([meta.status, meta.block_kind, marker()], ["reviewing", undefined, "review-running"]);

  // Any other kind leaves the marker alone.
  writeFileSync(join(worktree, ".harness", "state.md"), "# S1 — Demo story\n\n## Status\nreview-done\n", "utf8");
  writeFrontmatter(story, { status: "blocked", blocked_reason: "Could not open the PR.", blocked_from: "reviewing", block_kind: "pr" });
  await initiative.reopen(ref);
  assert.deepEqual([storyMeta(story).status, marker()], ["reviewing", "review-done"]);
});

test("retryStep starts one fresh session for a blocked story's step, round and cycle, and clears the block", async () => {
  const { root, worktree, story, labels } = fixture("a1");
  writeFileSync(
    join(worktree, ".harness", "state.md"),
    "# S1 — Demo story\n\n## Cycles\n\n- [x] Cycle 1 — First\n- [ ] Cycle 2 — Second\n\n## Status\nimplement-blocked\n",
    "utf8",
  );
  writeFrontmatter(story, {
    status: "blocked",
    blocked_reason: "Implement: Its session is gone. Gave up after 2 retries.",
    blocked_from: "implementing",
    block_kind: "retry-limit",
    waiting_on: "permission",
    stalled: "Its last turn failed: boom",
    retries: 2,
    round: 2,
    cycle: 2,
  });
  // The earlier session for the same step, round and cycle is closed, not gone.
  const { api, created } = fakePaseo([
    { id: "a1", labels: { ...labels, "loop-round": "2", "loop-cycle": "2" }, status: "closed" },
  ]);
  const initiative = loop();
  const ref = { repo: root, initiative: "demo", storyId: "S1" };

  const result = await initiative.retryStep(api, ref);

  assert.deepEqual(result, { ok: true, error: null, agentId: "n1" });
  assert.deepEqual(
    created.map((agent) => [agent.labels["loop-step"], agent.labels["loop-round"], agent.labels["loop-cycle"]]),
    [["implement", "2", "2"]],
  );
  assert.ok(created[0].labels["loop-retry"], "a fresh retry carries a loop-retry label");
  const meta = storyMeta(story);
  assert.deepEqual(
    [meta.status, meta.agent, meta.blocked_reason, meta.blocked_from, meta.block_kind, meta.waiting_on, meta.stalled],
    ["implementing", "n1", undefined, undefined, undefined, undefined, undefined],
  );
  assert.equal(readMarker(readFileSync(join(worktree, ".harness", "state.md"), "utf8")).marker, "implement-running");
});

test("retryStep refuses a story that isn't blocked, has no step, or isn't there, and leaves it alone", async () => {
  const { root, story } = fixture("a1");
  const { api, created } = fakePaseo([]);
  const initiative = loop();
  const ref = { repo: root, initiative: "demo", storyId: "S1" };

  const running = readFileSync(story, "utf8");
  const notBlocked = await initiative.retryStep(api, ref);
  assert.equal(notBlocked.ok, false);
  assert.equal(notBlocked.agentId, null);
  assert.equal(readFileSync(story, "utf8"), running);

  writeFrontmatter(story, { status: "blocked", blocked_reason: "Could not start.", blocked_from: "todo", block_kind: "start", step: null });
  const stepless = readFileSync(story, "utf8");
  const noStep = await initiative.retryStep(api, ref);
  assert.equal(noStep.ok, false);
  assert.equal(readFileSync(story, "utf8"), stepless);

  const missing = await initiative.retryStep(api, { ...ref, storyId: "S9" });
  assert.equal(missing.ok, false);
  assert.deepEqual(created, []);
});

test("closedPr gives a story's PR number while the PR is closed, and null once it isn't or there's none", async (t) => {
  t.after(() => ghPr(null));
  const { root, story } = fixture("a1");
  writeFrontmatter(story, { status: "blocked", blocked_reason: "PR #45 was closed without merging.", blocked_from: "pr-open", block_kind: "pr", pr: 45 });
  const initiative = loop();
  const ref = { repo: root, initiative: "demo", storyId: "S1" };

  ghPr("CLOSED");
  assert.equal(await initiative.closedPr(ref), 45);
  ghPr("OPEN");
  assert.equal(await initiative.closedPr(ref), null);
  ghPr(null);
  assert.equal(await initiative.closedPr(ref), null);
  assert.equal(await initiative.closedPr({ ...ref, storyId: "S9" }), null);
});
