import assert from "node:assert/strict";
import { test } from "node:test";
import { VOICE_HELPER_SYSTEM_PROMPT } from "../shared/voice-interpreter";
import { mcpScopeFor } from "./mcp-scope";
import { NO_TOOLS_OPTIONS, VOICE_HELPER_KIND, VOICE_HELPER_MODEL, createVoiceHelper, type VoiceHelperPorts, type VoiceHelperSpec } from "./voice-helper";

const CWD = "/tmp/voice-helper-test";

// A fake port: every create is captured with the MCP scope seen while it ran; a gate holds it open.
function fakePorts(opts: { failFirst?: boolean; run?: (agentId: string, prompt: string) => Promise<{ status: string; lastMessage: string | null }> } = {}) {
  const runs: { agentId: string; prompt: string; timeoutMs: number }[] = [];
  const read: string[] = [];
  const created: { spec: VoiceHelperSpec; scope: string }[] = [];
  const archived: string[] = [];
  let release: () => void = () => {};
  let gate: Promise<void> = Promise.resolve();
  let failNext = opts.failFirst === true;
  const ports: VoiceHelperPorts = {
    cwd: CWD,
    createAgent: async (spec) => {
      created.push({ spec, scope: mcpScopeFor(CWD) });
      await gate;
      if (failNext) {
        failNext = false;
        throw new Error("create failed");
      }
      return { id: `helper-${created.length}` };
    },
    archive: async (id) => {
      archived.push(id);
    },
    recentMessages: async (sessionId) => {
      read.push(sessionId);
      return [1, 2, 3, 4, 5, 6].map((n) => ({ role: n % 2 ? ("user" as const) : ("assistant" as const), text: `message ${n}` }));
    },
    run: async (agentId, prompt, timeoutMs) => {
      runs.push({ agentId, prompt, timeoutMs });
      return opts.run ? opts.run(agentId, prompt) : { status: "idle", lastMessage: '{"action":"send","text":"Merge it."}' };
    },
  };
  return {
    ports,
    runs,
    read,
    created,
    archived,
    hold() {
      gate = new Promise((resolve) => (release = resolve));
    },
    release: () => release(),
  };
}

test("start creates one Haiku helper with no MCP servers, no tools, the voice-helper label and the system prompt", async () => {
  const fake = fakePorts();
  const helper = createVoiceHelper(fake.ports);
  assert.equal(helper.agentId(), null);
  await helper.start();
  assert.equal(fake.created.length, 1);
  const { spec, scope } = fake.created[0];
  assert.equal(scope, "none");
  assert.equal(spec.provider, "claude/claude-haiku-4-5");
  assert.equal(VOICE_HELPER_MODEL, "claude/claude-haiku-4-5");
  assert.deepEqual(spec.options, NO_TOOLS_OPTIONS);
  assert.deepEqual(spec.labels, { kind: VOICE_HELPER_KIND });
  assert.equal(VOICE_HELPER_KIND, "voice-helper");
  assert.equal(spec.systemPrompt, VOICE_HELPER_SYSTEM_PROMPT);
  assert.equal(spec.cwd, CWD);
  assert.ok(spec.title.length > 0 && spec.title.length <= 60);
  assert.equal(helper.agentId(), "helper-1");
  assert.equal(mcpScopeFor(CWD), "all", "scope is released after create");
});

test("a second start, even concurrent, reuses the one helper", async () => {
  const fake = fakePorts();
  fake.hold();
  const helper = createVoiceHelper(fake.ports);
  const a = helper.start();
  const b = helper.start();
  fake.release();
  await Promise.all([a, b]);
  await helper.start();
  assert.equal(fake.created.length, 1);
  assert.equal(helper.agentId(), "helper-1");
});

test("stop archives the helper, and start after stop creates a new one", async () => {
  const fake = fakePorts();
  const helper = createVoiceHelper(fake.ports);
  await helper.start();
  await helper.stop();
  assert.deepEqual(fake.archived, ["helper-1"]);
  assert.equal(helper.agentId(), null);
  await helper.start();
  assert.equal(fake.created.length, 2);
  assert.equal(helper.agentId(), "helper-2");
});

test("stop with no helper does nothing", async () => {
  const fake = fakePorts();
  const helper = createVoiceHelper(fake.ports);
  await helper.stop();
  assert.deepEqual(fake.archived, []);
});

test("a failed create leaves no helper, so the next start retries", async () => {
  const fake = fakePorts({ failFirst: true });
  const helper = createVoiceHelper(fake.ports);
  await assert.rejects(helper.start(), /create failed/);
  assert.equal(helper.agentId(), null);
  await helper.start();
  assert.equal(fake.created.length, 2);
  assert.equal(helper.agentId(), "helper-2");
});

const SESSIONS = [
  { id: "s1", name: "Orchestrator" },
  { id: "s2", name: "Review" },
];
const ask = (helper: ReturnType<typeof createVoiceHelper>) => helper.interpret({ transcript: "merge England", sessionId: "s2", sessions: SESSIONS });

test("interpret puts the transcript, target title, session names and last 4 messages in the prompt, and parses the reply", async () => {
  const fake = fakePorts();
  const helper = createVoiceHelper(fake.ports);
  await helper.start();
  const result = await ask(helper);
  assert.deepEqual(result, { type: "send", text: "Merge it." });
  assert.deepEqual(fake.read, ["s2"]);
  const { prompt, timeoutMs } = fake.runs[0];
  assert.match(prompt, /Transcript: merge England/);
  assert.match(prompt, /Target session title: Review/);
  assert.match(prompt, /message 6/);
  assert.match(prompt, /message 3/);
  assert.doesNotMatch(prompt, /message 2/);
  assert.ok(timeoutMs > 3000 && timeoutMs <= 10000);
});

test("interpret parses a switch reply against the sessions", async () => {
  const fake = fakePorts({ run: async () => ({ status: "idle", lastMessage: '{"action":"switch","session":"orchestrator"}' }) });
  const helper = createVoiceHelper(fake.ports);
  await helper.start();
  assert.deepEqual(await ask(helper), { type: "switch", name: "Orchestrator" });
});

test("two interprets run on the same helper agent", async () => {
  const fake = fakePorts();
  const helper = createVoiceHelper(fake.ports);
  await helper.start();
  await ask(helper);
  await ask(helper);
  assert.deepEqual(fake.runs.map((r) => r.agentId), ["helper-1", "helper-1"]);
  assert.equal(fake.created.length, 1);
});

for (const status of ["permission", "error", "timeout"]) {
  test(`interpret throws when the run ends ${status}`, async () => {
    const fake = fakePorts({ run: async () => ({ status, lastMessage: '{"action":"send","text":"x"}' }) });
    const helper = createVoiceHelper(fake.ports);
    await helper.start();
    await assert.rejects(ask(helper), new RegExp(status));
  });
}

test("interpret throws when the run rejects", async () => {
  const fake = fakePorts({ run: async () => { throw new Error("daemon gone"); } });
  const helper = createVoiceHelper(fake.ports);
  await helper.start();
  await assert.rejects(ask(helper), /daemon gone/);
});

test("interpret throws when the helper was never started", async () => {
  const fake = fakePorts();
  const helper = createVoiceHelper(fake.ports);
  await assert.rejects(ask(helper), /not started/);
  assert.equal(fake.runs.length, 0);
});
