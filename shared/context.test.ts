import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contextAct,
  contextSessionsRpc,
  contextSettings,
  contextSummaryRpc,
  DEFAULT_CONTEXT_CONFIG,
  meterPolicy,
  type ContextConfig,
} from "./context";
import { LOOP_STEPS, type LoopStep } from "./initiative-loop";

const STEP = { warn: 70, act: 85 };

test("context settings default to 70/85 per step, fresh except implement, and auto-compact on", () => {
  assert.deepEqual(contextSettings.schema.parse({}), {
    default: { ...STEP, mode: "fresh" },
    plan: { ...STEP, mode: "fresh" },
    implement: { ...STEP, mode: "compact" },
    review: { ...STEP, mode: "fresh" },
    autoCompact: true,
  });
  assert.deepEqual(DEFAULT_CONTEXT_CONFIG, contextSettings.schema.parse({}));
});

test("context settings migrate v1 token counts to a default percent of 200k", () => {
  const migrate = contextSettings.migrate as (values: unknown, from: number) => ContextConfig;
  assert.deepEqual(migrate({ amber: 100_000, red: 150_000, autoCompact: false }, 1), {
    ...DEFAULT_CONTEXT_CONFIG,
    default: { warn: 50, act: 75, mode: "fresh" },
    autoCompact: false,
  });
  assert.equal(migrate({ amber: 1, red: 900_000 }, 1).default.act, 100);
  assert.deepEqual(migrate("junk", 1), DEFAULT_CONTEXT_CONFIG);
  assert.deepEqual(migrate({ amber: "x" }, 1), DEFAULT_CONTEXT_CONFIG);
  assert.deepEqual(migrate({ amber: 100_000, red: 150_000, autoCompact: "yes" }, 1).default, { warn: 50, act: 75, mode: "fresh" });
});

test("context.act accepts the five actions and rejects anything else", () => {
  for (const action of ["compact", "fresh", "remind", "ignore", "skip-auto"]) {
    assert.deepEqual(contextAct.input.parse({ agentId: "a1", action }), { agentId: "a1", action });
  }
  assert.equal(contextAct.input.safeParse({ agentId: "a1", action: "reset" }).success, false);
});

test("context.summary takes a null since", () => {
  assert.deepEqual(contextSummaryRpc.input.parse({ since: null }), { since: null });
});

test("context.summary takes an optional today for the spend windows", () => {
  const today = "2026-10-08T05:00:00.000Z";
  assert.deepEqual(contextSummaryRpc.input.parse({ since: "2026-10-01T00:00:00.000Z", today }), {
    since: "2026-10-01T00:00:00.000Z",
    today,
  });
  assert.deepEqual(contextSummaryRpc.input.parse({ since: null }), { since: null });
});

test("context.sessions takes agent ids and returns a status or null for each", () => {
  assert.deepEqual(contextSessionsRpc.input.parse({ agentIds: ["a1"] }), { agentIds: ["a1"] });
  const status = {
    agentId: "a1",
    reading: { used: null, max: null, level: "unknown", capability: "basic", strategy: "fresh" },
    warned: [],
    mode: "normal",
    red: 150_000,
    auto: true,
  };
  assert.deepEqual(contextSessionsRpc.output.parse([status, null]), [status, null]);
  assert.equal(contextSessionsRpc.output.safeParse([{ ...status, mode: "snooze" }]).success, false);
});

test("context.summary rejects a today that is not an ISO date-time", () => {
  assert.equal(contextSummaryRpc.input.safeParse({ since: null, today: "nope" }).success, false);
  assert.equal(contextSummaryRpc.input.safeParse({ since: null, today: "2026-10-08T00:00:00-05:00" }).success, true);
});

test("meterPolicy picks the step's policy through its phase, else default", () => {
  const config: ContextConfig = {
    default: { warn: 10, act: 20, mode: "fresh" },
    plan: { warn: 30, act: 40, mode: "fresh" },
    implement: { warn: 50, act: 60, mode: "compact" },
    review: { warn: 70, act: 80, mode: "fresh" },
    autoCompact: true,
  };
  const expected: Record<LoopStep, ContextConfig["default"]> = {
    plan: config.plan,
    diagnose: config.plan,
    implement: config.implement,
    fix: config.implement,
    review: config.review,
    pr: config.default,
  };
  for (const step of LOOP_STEPS) {
    assert.deepEqual(meterPolicy(config, { "loop-step": step }), { step: expected[step], fallback: config.default });
  }
  for (const labels of [{}, { "loop-step": "mystery" }, { "replay-step": "implement" }] as Record<string, string>[]) {
    assert.deepEqual(meterPolicy(config, labels), { step: config.default, fallback: config.default });
  }
});
