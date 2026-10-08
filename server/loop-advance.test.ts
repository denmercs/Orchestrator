import assert from "node:assert/strict";
import { test } from "node:test";
import { parentsForMerges } from "./loop-advance";

const agents: Parameters<typeof parentsForMerges>[0] = [
  { id: "epic-a", title: "KEY-1 — Epic A", labels: { kind: "epic-loop", jira: "KEY-1" } },
  { id: "epic-b", title: "KEY-2 — Epic B", labels: { kind: "epic-loop", jira: "KEY-2" } },
  { id: "child-labelled", title: "Something", labels: { jira: "KEY-10", "paseo.parent-agent-id": "epic-a" } },
  { id: "child-titled", title: "KEY-11 — Add search", parentAgentId: "epic-b", labels: {} },
  { id: "loose", title: "KEY-12 — No parent", labels: { jira: "KEY-12" } },
];

test("wakes the parent of the child whose key merged, found by label", () => {
  assert.deepEqual([...parentsForMerges(agents, [{ key: "KEY-10" }])], ["epic-a"]);
});

test("finds a child by the key at the start of its title and its Paseo parent", () => {
  assert.deepEqual([...parentsForMerges(agents, [{ key: "KEY-11" }])], ["epic-b"]);
});

test("a merge no child is working wakes nobody", () => {
  assert.equal(parentsForMerges(agents, [{ key: "OTHER-5" }, { key: "" }]).size, 0);
  assert.equal(parentsForMerges(agents, [{ key: "KEY-12" }]).size, 0);
});

test("a key does not match a longer key that starts with it", () => {
  assert.equal(parentsForMerges(agents, [{ key: "KEY-1" }]).size, 0);
});
