import assert from "node:assert/strict";
import { test } from "node:test";
import { DASHBOARD_ROUTER } from "./sulti-router";
import { createSultiStrip, latestReply } from "./sulti-strip";

const said = (text: string, timestamp: string) => ({ item: { type: "assistant_message", text }, timestamp });
const typed = (text: string, timestamp: string) => ({ item: { type: "user_message", text }, timestamp });
const tool = (timestamp: string) => ({ item: { type: "tool_call", status: "completed" }, timestamp });

test("latestReply returns the last assistant message and when it was said", () => {
  const entries = [said("First.", "2026-11-09T10:00:00Z"), typed("And?", "2026-11-09T10:01:00Z"), said("Second.", "2026-11-09T10:02:00Z")];
  assert.deepEqual(latestReply(entries), { text: "Second.", at: "2026-11-09T10:02:00Z" });
});

test("latestReply skips tool calls and user messages after the last reply", () => {
  const entries = [said("Done.", "2026-11-09T10:00:00Z"), tool("2026-11-09T10:01:00Z"), typed("Thanks", "2026-11-09T10:02:00Z")];
  assert.deepEqual(latestReply(entries), { text: "Done.", at: "2026-11-09T10:00:00Z" });
});

test("latestReply is null when there is no assistant message", () => {
  assert.equal(latestReply([typed("Hello", "2026-11-09T10:00:00Z"), tool("2026-11-09T10:01:00Z")]), null);
  assert.equal(latestReply([]), null);
});

test("read gives the Sulti id with its latest reply and when", async () => {
  const strip = createSultiStrip({
    sulti: async () => "sulti-1",
    timeline: async (id) => (id === "sulti-1" ? [said("Hello.", "2026-11-09T10:00:00Z")] : []),
    route: async () => ({ spoken: [], note: null }),
  });
  assert.deepEqual(await strip.read(), { sultiId: "sulti-1", reply: "Hello.", at: "2026-11-09T10:00:00Z", error: null });
});

test("read gives null reply when the timeline holds none", async () => {
  const strip = createSultiStrip({ sulti: async () => "sulti-1", timeline: async () => [], route: async () => ({ spoken: [], note: null }) });
  assert.deepEqual(await strip.read(), { sultiId: "sulti-1", reply: null, at: null, error: null });
});

test("read gives the error text and nulls when sulti() fails, and never throws", async () => {
  const strip = createSultiStrip({
    sulti: async () => {
      throw new Error("no paseo");
    },
    timeline: async () => [],
    route: async () => ({ spoken: [], note: null }),
  });
  assert.deepEqual(await strip.read(), { sultiId: null, reply: null, at: null, error: "no paseo" });
});

test("read keeps the Sulti id and gives the error text when the timeline fails", async () => {
  const strip = createSultiStrip({
    sulti: async () => "sulti-1",
    timeline: async () => {
      throw new Error("timeline down");
    },
    route: async () => ({ spoken: [], note: null }),
  });
  assert.deepEqual(await strip.read(), { sultiId: "sulti-1", reply: null, at: null, error: "timeline down" });
});

test("send routes typed text under the dashboard router and returns the result", async () => {
  const calls: unknown[][] = [];
  const strip = createSultiStrip({
    sulti: async () => "sulti-1",
    timeline: async () => [],
    route: async (...args) => {
      calls.push(args);
      return { spoken: ["On it."], note: "Switched." };
    },
  });
  assert.deepEqual(await strip.send("status please"), { spoken: ["On it."], note: "Switched." });
  assert.deepEqual(calls, [[DASHBOARD_ROUTER, "status please", undefined, { typed: true }]]);
});

test("send rejects blank text without routing", async () => {
  let routed = 0;
  const strip = createSultiStrip({
    sulti: async () => "sulti-1",
    timeline: async () => [],
    route: async () => {
      routed++;
      return { spoken: [], note: null };
    },
  });
  await assert.rejects(() => strip.send("   "));
  await assert.rejects(() => strip.send(""));
  assert.equal(routed, 0);
});
