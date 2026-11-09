import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { MANAGER_SESSION_MODELS, type ManagerPaseo } from "./factory-manager";
import { applySultiSession, ensureSulti, SULTI_SESSION_ENV } from "./sulti-session";

const marked = (systemPrompt?: string) => ({
  config: { provider: "claude", ...(systemPrompt ? { systemPrompt } : {}) },
  env: { [SULTI_SESSION_ENV]: "1" },
});

// What the Sulti prompt must say, each by a distinctive phrase: its role, then the limits.
const rules = [
  /global manager/i,
  /paseo tools/i,
  /across (all )?repos/i,
  /steer a repo's (factory )?manager/i,
  /never send[^.]*\$PASEO_AGENT_ID/i,
  /do not edit product code/i,
  /do not treat another agent's approval as permission to merge/i,
];

test("applySultiSession gives a marked request the Sulti prompt as its system prompt", () => {
  const prompt = applySultiSession(marked()).config.systemPrompt ?? "";
  for (const rule of rules) assert.match(prompt, rule);
});

test("applySultiSession appends the Sulti prompt after an existing system prompt", () => {
  const prompt = applySultiSession(marked("Be brief.")).config.systemPrompt ?? "";
  assert.ok(prompt.startsWith("Be brief.\n\n"));
  for (const rule of rules) assert.match(prompt, rule);
});

test("applySultiSession returns an unmarked request as the same object", () => {
  const plain = { config: { provider: "claude", systemPrompt: "Be brief." }, env: { OTHER: "1" } };
  assert.equal(applySultiSession(plain), plain);
  const off = { config: { provider: "claude" }, env: { [SULTI_SESSION_ENV]: "0" } };
  assert.equal(applySultiSession(off), off);
});

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A real temp home; with `agent` set it already holds sulti.json naming that id.
function tempHome(agent?: string) {
  const home = mkdtempSync(join(tmpdir(), "sulti-"));
  homes.push(home);
  if (agent) writeFileSync(join(home, "sulti.json"), JSON.stringify({ agent }));
  return home;
}
const idFile = (home: string) => JSON.parse(readFileSync(join(home, "sulti.json"), "utf8"));

type Created = Parameters<ManagerPaseo["agents"]["create"]>[0];

// A fake Paseo: `known` maps session ids to their state (absent = Paseo has no such session), `failing` provider names
// reject their create.
function fakePaseo(known: Record<string, { status: string; archivedAt?: string | null }> = {}, failing: string[] = []) {
  const created: Created[] = [];
  const paseo: ManagerPaseo = {
    agents: {
      ref: (id) => ({
        send: async () => undefined,
        refresh: async () => (known[id] ? { agent: known[id] } : null),
      }),
      create: async (request) => {
        created.push(request);
        await new Promise((resolve) => setImmediate(resolve));
        if (failing.includes(request.config.provider.split("/")[0])) throw new Error("unavailable");
        return { id: `new-${created.length}` };
      },
    },
  };
  return { paseo, created };
}

test("ensureSulti creates the Sulti session in <home>/sulti on Sonnet and records its id in sulti.json", async () => {
  const home = tempHome();
  const { paseo, created } = fakePaseo();
  assert.equal(await ensureSulti(paseo, home), "new-1");
  assert.deepEqual(created, [
    { cwd: join(home, "sulti"), config: MANAGER_SESSION_MODELS[0], env: { [SULTI_SESSION_ENV]: "1" }, title: "Sulti", labels: { kind: "sulti" } },
  ]);
  assert.ok(existsSync(join(home, "sulti")));
  assert.deepEqual(idFile(home), { agent: "new-1" });
  assert.ok(!existsSync(join(home, "manager.md")) && !existsSync(join(home, "sulti", "manager.md")));
});

test("ensureSulti falls back to Cursor Composer when the Claude create fails", async () => {
  const home = tempHome();
  const { paseo, created } = fakePaseo({}, ["claude"]);
  assert.equal(await ensureSulti(paseo, home), "new-2");
  assert.deepEqual(created.map((request) => request.config), [...MANAGER_SESSION_MODELS]);
  assert.deepEqual(idFile(home), { agent: "new-2" });
});

test("ensureSulti returns the live id from sulti.json without creating one", async () => {
  const home = tempHome("live-1");
  const { paseo, created } = fakePaseo({ "live-1": { status: "idle" } });
  assert.equal(await ensureSulti(paseo, home), "live-1");
  assert.equal(created.length, 0);
});

const dead: [string, string | undefined, Record<string, { status: string; archivedAt?: string | null }>][] = [
  ["no id in sulti.json", undefined, {}],
  ["an id Paseo no longer has", "gone", {}],
  ["an archived session", "old", { old: { status: "idle", archivedAt: "2026-01-01T00:00:00Z" } }],
  ["a closed session", "old", { old: { status: "closed" } }],
  ["a session in error", "old", { old: { status: "error" } }],
];
for (const [name, agent, known] of dead) {
  test(`ensureSulti creates a fresh session and records it when sulti.json has ${name}`, async () => {
    const home = tempHome(agent);
    const { paseo, created } = fakePaseo(known);
    assert.equal(await ensureSulti(paseo, home), "new-1");
    assert.equal(created.length, 1);
    assert.deepEqual(idFile(home), { agent: "new-1" });
  });
}

test("ensureSulti shares one create between two callers at once", async () => {
  const home = tempHome();
  const { paseo, created } = fakePaseo();
  const ids = await Promise.all([ensureSulti(paseo, home), ensureSulti(paseo, home)]);
  assert.deepEqual(ids, ["new-1", "new-1"]);
  assert.equal(created.length, 1);
});
