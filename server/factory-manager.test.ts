import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  applyFactoryManager,
  ensureManager,
  FACTORY_MANAGER_ENV,
  MANAGER_SESSION_MODELS,
  REPO_MANAGER_MODELS,
  hearthplayStepConfig,
  HEARTHPLAY_E4_MISSION,
  isGihimoRepo,
  isOrchestratorRepo,
  sliceRepoRoot,
  usesProductPlanReviewDefaults,
  type ManagerPaseo,
  steerManager,
  SYSTEM_TAG,
} from "./factory-manager";

const marked = (systemPrompt?: string) => ({
  config: { provider: "claude", ...(systemPrompt ? { systemPrompt } : {}) },
  env: { [FACTORY_MANAGER_ENV]: "1" },
});

// The three limits from the plan's Manager section, each by a distinctive phrase.
const limits = [
  /do not edit product code/i,
  /do not tell a worker to rewrite `culture\.md` or seat notes/i,
  /do not treat another agent's approval as permission to merge/i,
];

test("applyFactoryManager gives a marked request the manager prompt as its system prompt", () => {
  const prompt = applyFactoryManager(marked()).config.systemPrompt ?? "";
  assert.match(prompt, /\.harness\/factory\//);
  for (const limit of limits) assert.match(prompt, limit);
});

test("applyFactoryManager explains the [system] tag: lines starting with it come from the factory's code, not the human", () => {
  const prompt = applyFactoryManager(marked()).config.systemPrompt ?? "";
  assert.match(prompt, /\[system\]/);
  assert.match(prompt, /factory's own code/i);
  assert.match(prompt, /not the human/i);
});

test("applyFactoryManager appends the manager prompt after an existing system prompt", () => {
  const prompt = applyFactoryManager(marked("Be brief.")).config.systemPrompt ?? "";
  assert.ok(prompt.startsWith("Be brief.\n\n"));
  for (const limit of limits) assert.match(prompt, limit);
});

test("applyFactoryManager returns an unmarked request as the same object", () => {
  const plain = { config: { provider: "claude", systemPrompt: "Be brief." }, env: { OTHER: "1" } };
  assert.equal(applyFactoryManager(plain), plain);
  const off = { config: { provider: "claude" }, env: { [FACTORY_MANAGER_ENV]: "0" } };
  assert.equal(applyFactoryManager(off), off);
});

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A real temp root, a checkout of this repo (by its package name) unless `orchestrator` is false; with `agent` set it
// also has a factory whose manager.md holds that id.
function tempRoot(factory: boolean, agent?: string, orchestrator = true) {
  const root = mkdtempSync(join(tmpdir(), "manager-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: orchestrator ? "@denmercs/orchestrator" : "some-other-repo" }));
  if (factory) {
    mkdirSync(join(root, ".harness", "factory"), { recursive: true });
    if (agent) writeFileSync(join(root, ".harness", "factory", "manager.md"), `---\nagent: ${agent}\n---\n`);
  }
  return root;
}
const managerFile = (root: string) => readFileSync(join(root, ".harness", "factory", "manager.md"), "utf8");

type Created = Parameters<ManagerPaseo["agents"]["create"]>[0];

// A fake Paseo: `known` maps session ids to their state (absent = Paseo has no such session), `failing` provider names
// reject their create, `refreshError` makes every refresh throw.
function fakePaseo(known: Record<string, { status: string; archivedAt?: string | null }> = {}, failing: string[] = [], refreshError?: Error) {
  const created: Created[] = [];
  const sent: { id: string; text: string; options: unknown }[] = [];
  const paseo: ManagerPaseo = {
    agents: {
      ref: (id) => ({
        send: async (text, options) => {
          sent.push({ id, text, options });
        },
        refresh: async () => {
          if (refreshError) throw refreshError;
          return known[id] ? { agent: known[id] } : null;
        },
      }),
      create: async (request) => {
        created.push(request);
        await new Promise((resolve) => setImmediate(resolve));
        // The real client's check (parseProviderModel in @getpaseo/client).
        if (!/^[^/]+\/[^/]+$/.test(request.config.provider)) throw new Error('Expected config.provider in "provider/model" format');
        const provider = request.config.provider.split("/")[0];
        if (failing.includes(provider)) throw new Error(`${provider} is unavailable`);
        return { id: `new-${created.length}` };
      },
    },
  };
  return { paseo, created, sent };
}

test("sliceRepoRoot reads another checkout's package name through a worktree folder", () => {
  const home = tempRoot(false);
  const worktree = join(home, "slice-wt");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, "package.json"), JSON.stringify({ name: "quickpress" }));
  assert.equal(sliceRepoRoot(worktree, home), worktree);
  assert.equal(isOrchestratorRepo(sliceRepoRoot(worktree, home)), false);
  assert.equal(isOrchestratorRepo(sliceRepoRoot(join(home, "missing"), home)), true);
});

test("isGihimoRepo and usesProductPlanReviewDefaults", () => {
  const gihimoPkg = tempRoot(false, undefined, false);
  writeFileSync(join(gihimoPkg, "package.json"), JSON.stringify({ name: "gihimo" }));
  assert.equal(isGihimoRepo(gihimoPkg), true);
  assert.equal(usesProductPlanReviewDefaults(gihimoPkg), false);
  const quickpress = tempRoot(false, undefined, false);
  writeFileSync(join(quickpress, "package.json"), JSON.stringify({ name: "quickpress" }));
  assert.equal(usesProductPlanReviewDefaults(quickpress), true);
  const orchestrator = tempRoot(false, undefined, true);
  assert.equal(usesProductPlanReviewDefaults(orchestrator), false);
  const noPkgRoot = tempRoot(false, undefined, false);
  const gihimoPath = join(noPkgRoot, "gihimo");
  mkdirSync(gihimoPath, { recursive: true });
  assert.equal(isGihimoRepo(gihimoPath), true);
});

test("orchestratorStepConfig: plan on Opus, review on Grok, implement on Composer", async () => {
  const root = tempRoot(false, undefined, true);
  const profiles = {
    config: {
      get: async () => ({
        daemon: {
          agentProfiles: [
            { id: "thinker", name: "Business - Thinker", provider: "cursor", model: "grok-4.7" },
            { id: "coder", name: "Business - Coder", provider: "cursor", model: "composer-2.5" },
            { id: "opus", name: "Opus", provider: "cursor", model: "claude-opus-5-5" },
          ],
        },
      }),
    },
  };
  const fallback = { provider: "claude" };
  const { orchestratorStepConfig } = await import("./factory-manager");
  assert.deepEqual(await orchestratorStepConfig("plan", root, profiles, fallback), { provider: "cursor/claude-opus-5-5" });
  assert.deepEqual(await orchestratorStepConfig("review", root, profiles, fallback), { provider: "cursor/grok-4.7" });
  assert.deepEqual(await orchestratorStepConfig("implement", root, profiles, fallback), { provider: "cursor/composer-2.5" });
  assert.deepEqual(await orchestratorStepConfig("fix", root, profiles, fallback), { provider: "cursor/composer-2.5" });
  assert.deepEqual(await orchestratorStepConfig("diagnose", root, profiles, fallback), { provider: "cursor/grok-4.7" });
  assert.deepEqual(await orchestratorStepConfig("plan", tempRoot(false, undefined, false), profiles, fallback), { provider: "claude" });
});

test("orchestratorStepConfig: Claude deep and fast profiles when the daemon has no Cursor provider", async () => {
  const root = tempRoot(false, undefined, true);
  const agentProfiles = [
    { id: "opus", name: "Claude | Opus 5.5 - Planner", provider: "claude", model: "claude-opus-5-5", modeId: "auto" },
    { id: "sonnet", name: "Claude | Sonnet 5.5 - Coding", provider: "claude", model: "claude-sonnet-5-5", modeId: "auto" },
  ];
  const withProviders = (providers: Record<string, unknown>) => ({
    config: { get: async () => ({ daemon: { agentProfiles }, agents: { providers } }) },
  });
  const fallback = { provider: "claude" };
  const { orchestratorStepConfig } = await import("./factory-manager");
  const noCursor = withProviders({ kiro: { command: ["kiro-cli", "acp"] } });
  const opus = { provider: "claude/claude-opus-5-5", modeId: "auto" };
  const sonnet = { provider: "claude/claude-sonnet-5-5", modeId: "auto" };
  assert.deepEqual(await orchestratorStepConfig("plan", root, noCursor, fallback), opus);
  assert.deepEqual(await orchestratorStepConfig("review", root, noCursor, fallback), opus);
  assert.deepEqual(await orchestratorStepConfig("diagnose", root, noCursor, fallback), opus);
  assert.deepEqual(await orchestratorStepConfig("implement", root, noCursor, fallback), sonnet);
  assert.deepEqual(await orchestratorStepConfig("fix", root, noCursor, fallback), sonnet);
  assert.deepEqual(await orchestratorStepConfig("pr", root, noCursor, fallback), fallback);
  // The daemon's real response: { requestId, config: { providers, agentProfiles } }, providers {} when none is set.
  const daemon = (providers: Record<string, unknown>, profiles: unknown[] = agentProfiles) => ({
    config: { get: async () => ({ requestId: "r", config: { agentProfiles: profiles, providers } }) },
  });
  assert.deepEqual(await orchestratorStepConfig("implement", root, daemon({}), fallback), sonnet);
  assert.deepEqual(await orchestratorStepConfig("review", root, daemon({}), fallback), opus);
  // A leftover Cursor profile doesn't win over a disabled Cursor entry, but stands in for a missing one.
  const leftover = [...agentProfiles, { id: "c", name: "Coder", provider: "cursor", model: "composer-2.5" }];
  assert.deepEqual(await orchestratorStepConfig("plan", root, daemon({ cursor: { enabled: false } }, leftover), fallback), opus);
  assert.deepEqual(await orchestratorStepConfig("implement", root, daemon({}, leftover), fallback), { provider: "cursor/composer-2.5" });
  // A disabled Cursor entry counts as missing; an enabled one, or no providers list at all, keeps the Cursor split.
  assert.deepEqual(await orchestratorStepConfig("plan", root, withProviders({ cursor: { enabled: false } }), fallback), opus);
  assert.deepEqual(await orchestratorStepConfig("review", root, withProviders({ cursor: {} }), fallback), { provider: "cursor/grok-4.7" });
  const noList = { config: { get: async () => ({ daemon: { agentProfiles } }) } };
  assert.deepEqual(await orchestratorStepConfig("review", root, noList, fallback), { provider: "cursor/grok-4.7" });
});

test("orchestratorStepConfig: diagnose stays on Grok when profiles are unavailable", async () => {
  const root = tempRoot(false, undefined, true);
  const { orchestratorStepConfig } = await import("./factory-manager");
  assert.deepEqual(await orchestratorStepConfig("diagnose", root, { config: { get: async () => { throw new Error("off"); } } }, { provider: "claude" }), {
    provider: "cursor/grok-4.7",
  });
});

test("hearthplayStepConfig: plan on Opus, review on Grok, implement on Composer", async () => {
  const profiles = {
    config: {
      get: async () => ({
        daemon: {
          agentProfiles: [
            { id: "thinker", name: "Business - Thinker", provider: "cursor", model: "grok-4.7" },
            { id: "coder", name: "Business - Coder", provider: "cursor", model: "composer-2.5" },
            { id: "opus", name: "Opus", provider: "cursor", model: "claude-opus-5-5" },
          ],
        },
      }),
    },
  };
  const fallback = async () => ({ provider: "claude" });
  assert.deepEqual(await hearthplayStepConfig("plan", HEARTHPLAY_E4_MISSION, profiles, fallback), { provider: "cursor/claude-opus-5-5" });
  assert.deepEqual(await hearthplayStepConfig("review", HEARTHPLAY_E4_MISSION, profiles, fallback), { provider: "cursor/grok-4.7" });
  assert.deepEqual(await hearthplayStepConfig("implement", HEARTHPLAY_E4_MISSION, profiles, fallback), { provider: "cursor/composer-2.5" });
  assert.deepEqual(await hearthplayStepConfig("plan", "other-mission", profiles, fallback), { provider: "claude" });
});

test("ensureManager returns null and creates nothing when the root has no factory", async () => {
  const root = tempRoot(false);
  const { paseo, created } = fakePaseo();
  assert.equal(await ensureManager(root, paseo), null);
  assert.equal(created.length, 0);
});

test("ensureManager returns the live manager from manager.md without creating one", async () => {
  const root = tempRoot(true, "live-1");
  const { paseo, created } = fakePaseo({ "live-1": { status: "idle" } });
  assert.equal(await ensureManager(root, paseo), "live-1");
  assert.equal(created.length, 0);
});

const dead: [string, string | undefined, Record<string, { status: string; archivedAt?: string | null }>][] = [
  ["no id in manager.md", undefined, {}],
  ["an id Paseo no longer has", "gone", {}],
  ["an archived session", "old", { old: { status: "idle", archivedAt: "2026-01-01T00:00:00Z" } }],
  ["a closed session", "old", { old: { status: "closed" } }],
  ["a session in error", "old", { old: { status: "error" } }],
];
for (const [name, agent, known] of dead) {
  test(`ensureManager creates one manager on Cursor Composer 2.5 and records it when manager.md has ${name}`, async () => {
    const root = tempRoot(true, agent);
    const { paseo, created } = fakePaseo(known);
    assert.equal(await ensureManager(root, paseo), "new-1");
    assert.deepEqual(created, [
      { cwd: root, config: MANAGER_SESSION_MODELS[0], env: { [FACTORY_MANAGER_ENV]: "1" }, title: "Factory manager", labels: { kind: "factory-manager" } },
    ]);
    assert.match(managerFile(root), /^agent: new-1$/m);
  });
}

test("another repo's manager runs on Cursor Composer 2.5 only, and a failed create is not retried on Claude", async () => {
  const root = tempRoot(true, undefined, false);
  const { paseo, created } = fakePaseo();
  assert.equal(await ensureManager(root, paseo), "new-1");
  assert.deepEqual(created.map((request) => request.config), REPO_MANAGER_MODELS);
  const failing = fakePaseo({}, ["cursor"]);
  await assert.rejects(ensureManager(tempRoot(true, undefined, false), failing.paseo), /cursor is unavailable/);
  assert.deepEqual(failing.created.map((request) => request.config), REPO_MANAGER_MODELS);
});

test("ensureManager falls back to Cursor Composer 2.5 when the Claude create fails", async () => {
  const root = tempRoot(true);
  const { paseo, created } = fakePaseo({}, ["claude"]);
  assert.equal(await ensureManager(root, paseo), "new-2");
  assert.deepEqual(created.map((request) => request.config), [
    { provider: "claude/claude-sonnet-5-5", modeId: "auto" },
    { provider: "cursor/composer-2.5" },
  ]);
  assert.match(managerFile(root), /^agent: new-2$/m);
});

const withModel = (root: string, model: string) => writeFileSync(join(root, ".harness", "factory", "manager.md"), `---\nmodel: ${model}\n---\n`);

test("ensureManager creates on manager.md's model, then that provider's defaults only", async () => {
  const root = tempRoot(true);
  withModel(root, "cursor/grok-4.7");
  const { paseo, created } = fakePaseo({}, []);
  paseo.agents.create = async (request) => {
    created.push(request);
    if (request.config.provider === "cursor/grok-4.7") throw new Error("grok is unavailable");
    return { id: `new-${created.length}` };
  };
  assert.equal(await ensureManager(root, paseo), "new-2");
  assert.deepEqual(created.map((request) => request.config), [{ provider: "cursor/grok-4.7" }, { provider: "cursor/composer-2.5" }]);
  assert.match(managerFile(root), /^agent: new-2$/m);
  assert.match(managerFile(root), /^model: cursor\/grok-4\.7$/m);
});

test("ensureManager runs a Claude model from manager.md in auto mode, with no Cursor fallback", async () => {
  const root = tempRoot(true);
  withModel(root, "claude/claude-sonnet-5-5");
  const { paseo, created } = fakePaseo({}, ["claude"]);
  await assert.rejects(ensureManager(root, paseo), /claude is unavailable/);
  assert.deepEqual(created.map((request) => request.config), [{ provider: "claude/claude-sonnet-5-5", modeId: "auto" }]);
});

test("ensureManager throws instead of creating a second manager when Paseo does not answer", async () => {
  const root = tempRoot(true, "live-1");
  const { paseo, created } = fakePaseo({}, [], new Error("Paseo is down"));
  await assert.rejects(ensureManager(root, paseo), /Paseo is down/);
  assert.equal(created.length, 0);
  assert.match(managerFile(root), /^agent: live-1$/m);
});

test("ensureManager gives two concurrent callers the same single new manager", async () => {
  const root = tempRoot(true);
  const { paseo, created } = fakePaseo();
  const [first, second] = await Promise.all([ensureManager(root, paseo), ensureManager(root, paseo)]);
  assert.equal(created.length, 1);
  assert.equal(first, "new-1");
  assert.equal(second, "new-1");
});

const line = "Slice 3 is blocked on a plan gate.";
const steer = { activeTurnBehavior: "steer" };

test("steerManager sends the line once, as a steer, to the manager.md id only while other sessions are live", async () => {
  const root = tempRoot(true, "mgr");
  const { paseo, created, sent } = fakePaseo({ mgr: { status: "idle" }, worker: { status: "running" }, seat: { status: "idle" } });
  assert.equal(await steerManager(root, line, paseo), true);
  assert.deepEqual(sent, [{ id: "mgr", text: `[system] ${line}`, options: steer }]);
  assert.equal(created.length, 0);
});

test("steerManager prefixes every line with the SYSTEM_TAG", async () => {
  const root = tempRoot(true, "mgr");
  const { paseo, sent } = fakePaseo({ mgr: { status: "idle" } });
  await steerManager(root, "Slice s1 was filed.", paseo);
  assert.equal(SYSTEM_TAG, "[system]");
  assert.deepEqual(sent.map((one) => one.text), ["[system] Slice s1 was filed."]);
});

test("steerManager replaces a dead manager first and sends the line to the new one", async () => {
  const root = tempRoot(true, "old");
  const { paseo, created, sent } = fakePaseo({ old: { status: "closed" }, worker: { status: "running" } });
  assert.equal(await steerManager(root, line, paseo), true);
  assert.equal(created.length, 1);
  assert.deepEqual(sent, [{ id: "new-1", text: `[system] ${line}`, options: steer }]);
  assert.match(managerFile(root), /^agent: new-1$/m);
});

test("steerManager returns false and sends nothing when the root has no factory", async () => {
  const root = tempRoot(false);
  const { paseo, created, sent } = fakePaseo({ worker: { status: "running" } });
  assert.equal(await steerManager(root, line, paseo), false);
  assert.equal(sent.length, 0);
  assert.equal(created.length, 0);
});

function missionFactory(root: string, globalAgent: string, missions: Record<string, string | undefined>) {
  writeFileSync(join(root, ".harness", "factory", "manager.md"), `---\nagent: ${globalAgent}\n---\n`);
  for (const [id, manager] of Object.entries(missions)) {
    const dir = join(root, ".harness", "factory", "missions", id);
    mkdirSync(dir, { recursive: true });
    const head = manager ? `---\nmanager: ${manager}\n---\n\n` : "";
    writeFileSync(join(dir, "mission.md"), `${head}Outcome for ${id}.\n`);
  }
}

test("steerManager routes to a mission manager when mission.md sets manager", async () => {
  const root = tempRoot(true);
  missionFactory(root, "repo-mgr", { "quickpress-rea": "qp-mgr" });
  const { paseo, sent } = fakePaseo({ "repo-mgr": { status: "idle" }, "qp-mgr": { status: "idle" } });
  assert.equal(await steerManager(root, "Slice s1 is ready.", paseo, "quickpress-rea"), true);
  assert.deepEqual(sent, [{ id: "qp-mgr", text: `[system] Slice s1 is ready.`, options: steer }]);
});

test("steerManager without a mission routes to manager.md", async () => {
  const root = tempRoot(true);
  missionFactory(root, "repo-mgr", { m1: "qp-mgr" });
  const { paseo, sent } = fakePaseo({ "repo-mgr": { status: "idle" }, "qp-mgr": { status: "idle" } });
  await steerManager(root, "Swept stray slice workspaces: archived 0.", paseo);
  assert.deepEqual(sent.map((item) => item.id), ["repo-mgr"]);
});

test("steerManager falls back to manager.md when the mission manager field is unset or empty", async () => {
  const root = tempRoot(true);
  missionFactory(root, "repo-mgr", { "no-mgr": undefined, "blank-mgr": "" });
  writeFileSync(join(root, ".harness", "factory", "missions", "blank-mgr", "mission.md"), "---\nmanager:\n---\n\nBlank.\n");
  const { paseo, sent } = fakePaseo({ "repo-mgr": { status: "idle" } });
  await steerManager(root, "Slice a held.", paseo, "no-mgr");
  await steerManager(root, "Slice b held.", paseo, "blank-mgr");
  assert.deepEqual(sent.map((item) => item.id), ["repo-mgr", "repo-mgr"]);
});

test("steerManager can reach two mission managers and the repo manager in one session", async () => {
  const root = tempRoot(true);
  missionFactory(root, "repo-mgr", { m1: "mgr-one", m2: "mgr-two" });
  const { paseo, sent } = fakePaseo({
    "repo-mgr": { status: "idle" },
    "mgr-one": { status: "idle" },
    "mgr-two": { status: "idle" },
  });
  await steerManager(root, "Slice s1 held.", paseo, "m1");
  await steerManager(root, "Slice s2 held.", paseo, "m2");
  await steerManager(root, "Sweep done.", paseo);
  assert.deepEqual(sent.map((item) => item.id), ["mgr-one", "mgr-two", "repo-mgr"]);
});
