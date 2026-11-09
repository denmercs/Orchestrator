import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

test("the initiative loop and the LoopHost type import nothing from @getpaseo, so a host needs only the type", () => {
  for (const file of ["./initiative-loop.ts", "../shared/loop-host.ts"]) {
    assert.doesNotMatch(source(file), /@getpaseo/, `${file} must not name Paseo`);
  }
});

test("the loop does not reach for the Paseo adapter either", () => {
  assert.doesNotMatch(source("./initiative-loop.ts"), /loop-host-paseo/);
});

// The rest of this file drives the loop through `fakeLoopHost` alone: no Paseo handle anywhere.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FALLBACK_AGENT_CONFIG } from "../shared/agent-runner";
import { DEFAULT_LOOP_CONFIG } from "../shared/initiative-loop";
import { DEFAULT_PHASES } from "../shared/pipeline";
import { fakeLoopHost } from "../test-support/fake-loop-host";
import { frontmatter } from "./harness-layout";

process.env.HOME = mkdtempSync(join(tmpdir(), "loop-contract-home-"));
const { createInitiativeLoop } = await import("./initiative-loop");

// A repo with one todo story and the loop on, a fake host, and the loop over them. `story` is the story file.
function todoInitiative() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loop-contract-")));
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
  mkdirSync(join(process.env.HOME as string, ".orchestrator"), { recursive: true });
  const { host, created } = fakeLoopHost([]);
  const loop = createInitiativeLoop(async () => DEFAULT_LOOP_CONFIG, async () => FALLBACK_AGENT_CONFIG, async () => ({ phases: DEFAULT_PHASES, sources: [] }));
  return { root, story, host, created, loop };
}

test("start, then a plan turn that ends without plan-done, leaves the story awaiting approval on a host that is only the LoopHost type", async () => {
  // Arrange: a repo with one todo story and the loop on.
  const { root, story, host, created, loop } = todoInitiative();

  // Act: start the initiative; the plan agent is created with its labels.
  const started = await loop.start(host, { repo: root, initiative: "demo" });
  assert.equal(started.error, null);
  assert.equal(created.length, 1);
  assert.equal(created[0].labels.kind, "initiative-loop");
  assert.equal(created[0].labels["loop-step"], "plan");
  assert.equal(created[0].labels["loop-story"], "S1");
  const meta = frontmatter(readFileSync(story, "utf8"));
  assert.equal(meta.status, "planning");

  // The plan agent ends its turn still planning: it is asking for approval (plan-done would start Implement instead).
  writeFileSync(join(meta.worktree, ".harness", "state.md"), "# S1\n\n## Status\nplan-running\n", "utf8");
  await loop.onTurnEnded(host, { agentId: meta.agent, outcome: { kind: "completed" } });

  // Assert: the story waits for approval, and no second agent was started.
  assert.equal(frontmatter(readFileSync(story, "utf8")).status, "awaiting-approval");
  assert.equal(created.length, 1);
});

test("a plan-done turn end on the same host starts the Implement agent with loop labels", async () => {
  // Arrange: a started initiative whose plan agent has written plan-done.
  const { root, story, host, created, loop } = todoInitiative();
  await loop.start(host, { repo: root, initiative: "demo" });
  const meta = frontmatter(readFileSync(story, "utf8"));
  writeFileSync(join(meta.worktree, ".harness", "state.md"), "# S1\n\n## Status\nplan-done\n\n## Cycles\n- [ ] Cycle 1 — Reads: test → change\n", "utf8");

  // Act
  await loop.onTurnEnded(host, { agentId: meta.agent, outcome: { kind: "completed" } });

  // Assert: the Implement agent was created with its loop-step label, and the story is implementing.
  assert.equal(created.length, 2);
  assert.equal(created[1].labels["loop-step"], "implement");
  assert.equal(frontmatter(readFileSync(story, "utf8")).status, "implementing");
});

test("a started story's workspace shows in the host's workspace list, so the loop reads workspaces through the type alone", async () => {
  // Arrange: a started initiative on the fake host.
  const { root, host, loop } = todoInitiative();

  // Act
  await loop.start(host, { repo: root, initiative: "demo" });

  // Assert: the story's workspace is listed with its folder, the repo root, and not busy.
  assert.deepEqual(await host.listWorkspaces(), [{ id: "ws1", directory: root, projectRootPath: root, busy: false }]);
});
