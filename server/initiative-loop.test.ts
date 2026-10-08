import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { DEFAULT_LOOP_CONFIG } from "../shared/initiative-loop";
import { FALLBACK_AGENT_CONFIG } from "../shared/agent-runner";
import { frontmatter } from "./harness-layout";

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
  const created: { workspace: string; title: string; labels: Record<string, string> }[] = [];
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
          create: async (options: { title: string; labels: Record<string, string> }) => {
            const id = `n${created.length + 1}`;
            created.push({ workspace, title: options.title, labels: options.labels });
            live.push({ id, labels: options.labels });
            return { id };
          },
        },
      }),
    },
  };
  return { api: api as unknown as PaseoApi, created };
}

const loop = () => createInitiativeLoop(async () => DEFAULT_LOOP_CONFIG, async () => FALLBACK_AGENT_CONFIG);
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
  assert.match(prompt, /## This step: Cycle 2 only\n- \[ \] Cycle 2 — Warns/);
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
