import assert from "node:assert/strict";
import { test } from "node:test";
import { isStatusAsk, statusLine, type StatusAgent } from "./voice-status";

const agent = (id: string, extra: Partial<StatusAgent> = {}): StatusAgent => ({ id, title: id, status: "idle", ...extra });

test("short status phrases are a status ask, with or without the name", () => {
  assert.equal(isStatusAsk("Jarvis, status"), true);
  assert.equal(isStatusAsk("status"), true);
  assert.equal(isStatusAsk("give me a status"), true);
  assert.equal(isStatusAsk("what are the agents doing"), true);
  assert.equal(isStatusAsk("Jarvis, what's going on?"), true);
});

test("long requests and other words are not a status ask", () => {
  assert.equal(isStatusAsk("the status of the build is red, fix it"), false);
  assert.equal(isStatusAsk("good morning"), false);
  // Starts like a status ask but carries a request for the session.
  assert.equal(isStatusAsk("status check the logs"), false);
  assert.equal(isStatusAsk("status of the build is red"), false);
});

test("with nothing running and nothing stuck it says so", () => {
  assert.equal(statusLine([]), "Nothing is running.");
});

test("a session waiting on permission is named first, then who is running", () => {
  const line = statusLine([agent("alpha", { status: "running" }), agent("beta", { status: "running" }), agent("gamma", { status: "running", pendingPermissions: [{}] })]);
  assert.equal(line, "gamma needs you. alpha and beta are running.");
});

test("a session in error is named", () => {
  assert.equal(statusLine([agent("delta", { status: "error" })]), "delta hit an error.");
  assert.equal(statusLine([agent("delta", { status: "idle", attentionReason: "error" })]), "delta hit an error.");
});

test("idle sessions are only counted, after what is running", () => {
  assert.equal(statusLine([agent("alpha", { status: "running" }), agent("b"), agent("c")]), "alpha is running. Two idle.");
  assert.equal(statusLine([agent("b"), agent("c")]), "Nothing is running. Two idle.");
});

test("more than three in a group: three names, then the rest as a count, within the spoken cap", () => {
  const five = ["a", "b", "c", "d", "e"].map((id) => agent(id, { status: "running" }));
  assert.equal(statusLine(five), "a, b, c and two more are running.");
  // Three groups of three long names would run past the cap; the line is cut at a sentence end.
  const long = "refactoring the authentication middleware layer";
  const wide = statusLine([
    ...["1", "2", "3"].map((id) => agent(id, { title: `${long} ${id}`, status: "running", pendingPermissions: [{}] })),
    ...["4", "5", "6"].map((id) => agent(id, { title: `${long} ${id}`, status: "error" })),
    ...["7", "8", "9"].map((id) => agent(id, { title: `${long} ${id}`, status: "running" })),
  ]);
  assert.ok(wide.length <= 300);
  assert.match(wide, /need you\.$/);
});

test("closed, archived and Voice's own sessions are not counted", () => {
  const line = statusLine([
    agent("old", { status: "closed" }),
    agent("gone", { status: "running", archivedAt: "2026-10-01" }),
    agent("jarvis", { status: "running", provider: "jarvis" }),
    agent("helper", { status: "running", labels: { kind: "voice-helper" } }),
  ]);
  assert.equal(line, "Nothing is running.");
});
