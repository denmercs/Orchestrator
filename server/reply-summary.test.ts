import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { mcpScopeFor } from "./mcp-scope";
import { REPLY_SUMMARY_SYSTEM_PROMPT, SUMMARY_FALLBACK_MS, createReplySummary } from "./reply-summary";
import { NO_TOOLS_OPTIONS, VOICE_HELPER_KIND, VOICE_HELPER_MODEL, type VoiceHelperPorts, type VoiceHelperSpec } from "./voice-helper";

const CWD = "/tmp/reply-summary-test";
const LONG = "The build finished and every check passed. ".repeat(20); // ~880 chars
type Run = { status: string; lastMessage: string | null };

function fakePorts(run: (prompt: string) => Promise<Run> = async () => ({ status: "idle", lastMessage: "All good." })) {
  const runs: { agentId: string; prompt: string }[] = [];
  const created: { spec: VoiceHelperSpec; scope: string }[] = [];
  const archived: string[] = [];
  const ports: VoiceHelperPorts = {
    cwd: CWD,
    createAgent: async (spec) => {
      created.push({ spec, scope: mcpScopeFor(CWD) });
      return { id: "summary-1" };
    },
    archive: async (id) => void archived.push(id),
    recentMessages: async () => [],
    run: async (agentId, prompt) => {
      runs.push({ agentId, prompt });
      return run(prompt);
    },
  };
  return { ports, runs, created, archived };
}

test("start creates a Haiku agent with no MCP servers, no tools, the voice-helper label and its own prompt; stop archives it", async () => {
  const fake = fakePorts();
  const s = createReplySummary(fake.ports);
  await s.start();
  await s.start();
  assert.equal(fake.created.length, 1);
  const { spec, scope } = fake.created[0];
  assert.equal(scope, "none");
  assert.equal(spec.provider, VOICE_HELPER_MODEL);
  assert.deepEqual(spec.options, NO_TOOLS_OPTIONS);
  assert.deepEqual(spec.labels, { kind: VOICE_HELPER_KIND });
  assert.equal(spec.systemPrompt, REPLY_SUMMARY_SYSTEM_PROMPT);
  assert.equal(spec.cwd, CWD);
  assert.match(REPLY_SUMMARY_SYSTEM_PROMPT, /400/);
  await s.stop();
  assert.deepEqual(fake.archived, ["summary-1"]);
});

test("an answer inside the limit is the summary", async () => {
  const fake = fakePorts();
  const s = createReplySummary(fake.ports);
  await s.start();
  assert.equal(await s.summarize(LONG), "All good.");
});

test("a run that outlives 3 s gives null at 3 s, and its late answer is ignored", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let answer: (r: Run) => void = () => {};
    const fake = fakePorts(() => new Promise<Run>((resolve) => (answer = resolve)));
    const s = createReplySummary(fake.ports);
    await s.start();
    let got: string | null | undefined;
    const pending = s.summarize(LONG).then((v) => (got = v));
    await Promise.resolve();
    mock.timers.tick(SUMMARY_FALLBACK_MS - 1);
    await Promise.resolve();
    assert.equal(got, undefined);
    mock.timers.tick(1);
    await pending;
    assert.equal(SUMMARY_FALLBACK_MS, 3000);
    assert.equal(got, null);
    answer({ status: "idle", lastMessage: "Too late." });
    await Promise.resolve();
    assert.equal(got, null);
  } finally {
    mock.timers.reset();
  }
});

test("a failed or non-idle run is null", async () => {
  const boom = createReplySummary(fakePorts(async () => Promise.reject(new Error("boom"))).ports);
  await boom.start();
  assert.equal(await boom.summarize(LONG), null);
  const errored = createReplySummary(fakePorts(async () => ({ status: "error", lastMessage: "x" })).ports);
  await errored.start();
  assert.equal(await errored.summarize(LONG), null);
  const empty = createReplySummary(fakePorts(async () => ({ status: "idle", lastMessage: "  " })).ports);
  await empty.start();
  assert.equal(await empty.summarize(LONG), null);
});

test("not started is null at once, with no run", async () => {
  const fake = fakePorts();
  const s = createReplySummary(fake.ports);
  assert.equal(await s.summarize(LONG), null);
  assert.equal(fake.runs.length, 0);
});

test("a run still in flight makes the next summarize null without a second run", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const fake = fakePorts(() => new Promise<Run>(() => {}));
    const s = createReplySummary(fake.ports);
    await s.start();
    const first = s.summarize(LONG);
    await Promise.resolve();
    mock.timers.tick(SUMMARY_FALLBACK_MS);
    assert.equal(await first, null);
    assert.equal(await s.summarize(LONG), null);
    assert.equal(fake.runs.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("a short reply skips the helper", async () => {
  const fake = fakePorts();
  const s = createReplySummary(fake.ports);
  await s.start();
  assert.equal(await s.summarize("Done. Tests pass."), null);
  assert.equal(fake.runs.length, 0);
});

test("the prompt is only the reply text, code fences left out, capped at 4000", async () => {
  const fake = fakePorts();
  const s = createReplySummary(fake.ports);
  await s.start();
  const fenced = `${LONG}\n\`\`\`ts\nconst secret = 1;\n\`\`\`\nAfter the code.`;
  await s.summarize(fenced);
  assert.ok(!fake.runs[0].prompt.includes("secret"));
  assert.ok(fake.runs[0].prompt.includes("After the code."));
  assert.ok(fake.runs[0].prompt.startsWith("The build finished"));
  await s.summarize("word ".repeat(2000));
  assert.equal(fake.runs[1].prompt.length, 4000);
});

test("after voice turns off and on, a run left over from the old agent does not make the new one busy", async () => {
  const fake = fakePorts(() => new Promise<Run>(() => {}));
  let n = 0;
  fake.ports.createAgent = async () => ({ id: `summary-${++n}` });
  const s = createReplySummary(fake.ports, { timeoutMs: 1 });
  await s.start();
  assert.equal(await s.summarize(LONG), null);
  await s.stop();
  await s.start();
  await s.summarize(LONG);
  assert.deepEqual(fake.runs.map((r) => r.agentId), ["summary-1", "summary-2"]);
});
