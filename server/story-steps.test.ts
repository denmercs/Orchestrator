import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FALLBACK_AGENT_CONFIG } from "../shared/agent-runner";
import { DEFAULT_LOOP_CONFIG } from "../shared/initiative-loop";
import { DEFAULT_PHASES } from "../shared/pipeline";
import { readMarker, type StoryContext } from "../shared/story-method";
import { frontmatter } from "./harness-layout";
import { loadPhaseConfig, loadStepConfig } from "./agent-runner";
import { launchStep } from "./story-steps";

type Spec = { title: string; config: unknown; prompt: string; labels: Record<string, string> };

// A story file and a worktree with nothing around them: no initiative, no phase, no workspace.
function bare() {
  const dir = mkdtempSync(join(tmpdir(), "story-steps-"));
  const worktree = join(dir, "wt");
  mkdirSync(join(worktree, ".harness"), { recursive: true });
  const storyFile = join(dir, "S1.md");
  writeFileSync(storyFile, "---\nid: S1\ntitle: Demo story\nstatus: ready\n---\n\n## Goal\n\nShip it.\n", "utf8");
  const ctx: StoryContext = {
    id: "S1",
    title: "Demo story",
    body: "## Goal\n\nShip it.\n",
    ticketKey: null,
    ticketUrl: null,
    storyFile,
    storiesDir: dir,
    phaseLabel: "",
    phaseTitle: "",
    architectureFile: null,
    initiativeTitle: "",
    initiativeFile: join(dir, "initiative.md"),
    branch: "feature/s1",
    base: "origin/main",
  };
  return { worktree, storyFile, ctx };
}

const labels = { kind: "factory-seat", "loop-step": "implement", "loop-round": "2" };

test("launchStep marks the step running, starts the agent with its labels and prompt, and records it on the story", async () => {
  // Arrange: a story file and a worktree, and a create that records what it is given.
  const { worktree, storyFile, ctx } = bare();
  const created: Spec[] = [];
  // Act
  const id = await launchStep({
    api: { config: { get: async () => ({}) } },
    storyFile,
    worktree,
    ctx,
    step: "implement",
    round: 2,
    labels,
    readPipeline: async () => ({ phases: DEFAULT_PHASES, sources: [] }),
    readAgentConfig: async () => FALLBACK_AGENT_CONFIG,
    create: async (spec) => {
      created.push(spec);
      return { id: "agent-7" };
    },
  });
  // Assert: the marker, the story's step fields and the agent's labels and prompt.
  assert.equal(id, "agent-7");
  assert.equal(readMarker(readFileSync(join(worktree, ".harness", "state.md"), "utf8")).marker, "implement-running");
  const meta = frontmatter(readFileSync(storyFile, "utf8"));
  assert.equal(meta.status, "implementing");
  assert.equal(meta.step, "implement");
  assert.equal(meta.round, "2");
  assert.equal(meta.agent, "agent-7");
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].labels, labels);
  assert.match(created[0].title, /S1 · Implement r2 — Demo story/);
  assert.match(created[0].prompt, /Demo story/);
});

test("launchStep leaves the story untouched when the agent fails to start", async () => {
  // Arrange
  const { worktree, storyFile, ctx } = bare();
  // Act + assert: the error comes back, and no agent is recorded.
  await assert.rejects(
    launchStep({
      api: { config: { get: async () => ({}) } },
      storyFile,
      worktree,
      ctx,
      step: "plan",
      round: 1,
      labels,
      readPipeline: async () => ({ phases: DEFAULT_PHASES, sources: [] }),
      readAgentConfig: async () => FALLBACK_AGENT_CONFIG,
      create: async () => {
        throw new Error("no daemon");
      },
    }),
    /no daemon/,
  );
  const meta = frontmatter(readFileSync(storyFile, "utf8"));
  assert.equal(meta.status, "ready");
  assert.equal(meta.agent, undefined);
});

test("loadPhaseConfig and loadStepConfig read profiles from a plain { config: { get } } object", async () => {
  // Arrange: no Paseo handle, only the one call the runner helpers make.
  const profiles = {
    config: { get: async () => ({ daemon: { agentProfiles: [{ id: "p1", name: "fast", provider: "claude", model: "haiku" }] } }) },
  };
  const fallback = { provider: "claude", modeId: "auto" };

  // Act and assert: a named profile is found, an unknown one falls back, and a step reads its default.
  assert.deepEqual(await loadPhaseConfig(profiles, "fast", fallback), { provider: "claude/haiku" });
  assert.deepEqual(await loadPhaseConfig(profiles, "missing", fallback), fallback);
  const step = await loadStepConfig(profiles, DEFAULT_LOOP_CONFIG, "implement", "");
  assert.equal(typeof step.provider, "string");
});
