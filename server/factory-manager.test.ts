import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { applyFactoryManager, ensureManager, FACTORY_MANAGER_ENV, MANAGER_MODELS, type ManagerPaseo, steerManager } from "./factory-manager";

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

// A real temp root; with `agent` set it also has a factory whose manager.md holds that id.
function tempRoot(factory: boolean, agent?: string) {
  const root = mkdtempSync(join(tmpdir(), "manager-"));
  roots.push(root);
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
  test(`ensureManager creates one manager on Claude Opus and records it when manager.md has ${name}`, async () => {
    const root = tempRoot(true, agent);
    const { paseo, created } = fakePaseo(known);
    assert.equal(await ensureManager(root, paseo), "new-1");
    assert.deepEqual(created, [
      { cwd: root, config: MANAGER_MODELS[0], env: { [FACTORY_MANAGER_ENV]: "1" }, title: "Factory manager", labels: { kind: "factory-manager" } },
    ]);
    assert.match(managerFile(root), /^agent: new-1$/m);
  });
}

test("ensureManager falls back to Cursor Grok 4.7 when the Claude create fails", async () => {
  const root = tempRoot(true);
  const { paseo, created } = fakePaseo({}, ["claude"]);
  assert.equal(await ensureManager(root, paseo), "new-2");
  assert.deepEqual(created.map((request) => request.config), [
    { provider: "claude/claude-opus-5-5", modeId: "auto" },
    { provider: "cursor/grok-4.7" },
  ]);
  assert.match(managerFile(root), /^agent: new-2$/m);
});

test("ensureManager throws and leaves manager.md alone when both creates fail", async () => {
  const root = tempRoot(true, "old");
  const { paseo, created } = fakePaseo({ old: { status: "closed" } }, ["claude", "cursor"]);
  await assert.rejects(ensureManager(root, paseo), /cursor is unavailable/);
  assert.equal(created.length, 2);
  assert.match(managerFile(root), /^agent: old$/m);
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
  assert.deepEqual(sent, [{ id: "mgr", text: line, options: steer }]);
  assert.equal(created.length, 0);
});

test("steerManager replaces a dead manager first and sends the line to the new one", async () => {
  const root = tempRoot(true, "old");
  const { paseo, created, sent } = fakePaseo({ old: { status: "closed" }, worker: { status: "running" } });
  assert.equal(await steerManager(root, line, paseo), true);
  assert.equal(created.length, 1);
  assert.deepEqual(sent, [{ id: "new-1", text: line, options: steer }]);
  assert.match(managerFile(root), /^agent: new-1$/m);
});

test("steerManager returns false and sends nothing when the root has no factory", async () => {
  const root = tempRoot(false);
  const { paseo, created, sent } = fakePaseo({ worker: { status: "running" } });
  assert.equal(await steerManager(root, line, paseo), false);
  assert.equal(sent.length, 0);
  assert.equal(created.length, 0);
});
