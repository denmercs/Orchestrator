// withMergedAt (frontmatter insert), agentClosedAt (latest agent time) and pickMergedAt (PR, then agent, then none).
import { test } from "node:test";
import assert from "node:assert/strict";
import { withMergedAt, agentClosedAt, pickMergedAt } from "./merged-at.mjs";

const ISO = "2026-10-08T18:38:58Z";

test("adds merged_at before the closing --- and leaves the rest byte-identical", () => {
  const text = "---\nid: S1\nstatus: merged\npr: 12\n---\n\n# Title\n\nbody  \n";
  assert.equal(withMergedAt(text, ISO), `---\nid: S1\nstatus: merged\npr: 12\nmerged_at: ${ISO}\n---\n\n# Title\n\nbody  \n`);
});

test("returns null when merged_at is already in the frontmatter", () => {
  assert.equal(withMergedAt(`---\nstatus: merged\nmerged_at: ${ISO}\n---\nbody\n`, ISO), null);
});

test("a merged_at in the body does not count", () => {
  const text = "---\nstatus: merged\n---\nmerged_at: nope\n";
  assert.equal(withMergedAt(text, ISO), `---\nstatus: merged\nmerged_at: ${ISO}\n---\nmerged_at: nope\n`);
});

test("agentClosedAt returns the latest timestamp across all agents' entries, as the original string", () => {
  const entries = [
    [{ timestamp: "2026-10-07T04:39:04.721Z" }, { timestamp: "2026-10-07T04:10:00Z" }],
    [{ timestamp: "2026-10-08T18:38:58.296Z" }],
    [{ timestamp: "2026-10-08T09:00:00+00:00" }],
  ];
  assert.equal(agentClosedAt(entries), "2026-10-08T18:38:58.296Z");
});

test("agentClosedAt compares times, not strings", () => {
  const entries = [[{ timestamp: "2026-10-08T23:00:00-05:00" }, { timestamp: "2026-10-09T01:00:00Z" }]];
  assert.equal(agentClosedAt(entries), "2026-10-08T23:00:00-05:00");
});

test("agentClosedAt skips entries with no timestamp", () => {
  assert.equal(agentClosedAt([[{ type: "x" }, { timestamp: ISO }, {}]]), ISO);
});

test("agentClosedAt is null for no agents or no timestamps", () => {
  assert.equal(agentClosedAt([]), null);
  assert.equal(agentClosedAt([[], [{ type: "x" }]]), null);
});

const PRS = [
  { number: 12, headRefName: "feat/a", mergedAt: "2026-10-01T10:00:00Z" },
  { number: 40, headRefName: "feat/b", mergedAt: "2026-10-02T10:00:00Z" },
];
const AGENT = "2026-10-07T04:39:04.721Z";

test("pickMergedAt matches the PR by pr: number first", () => {
  assert.deepEqual(pickMergedAt({ pr: "12", branch: "feat/b" }, PRS, AGENT), { at: "2026-10-01T10:00:00Z", source: "pr #12" });
});

test("pickMergedAt falls back to the branch when there is no pr: match", () => {
  assert.deepEqual(pickMergedAt({ branch: "feat/b" }, PRS, AGENT), { at: "2026-10-02T10:00:00Z", source: "pr #40" });
  assert.deepEqual(pickMergedAt({ pr: "99", branch: "feat/b" }, PRS, AGENT), { at: "2026-10-02T10:00:00Z", source: "pr #40" });
});

test("pickMergedAt uses the agent time when no PR matches", () => {
  assert.deepEqual(pickMergedAt({ pr: "99", branch: "nope" }, PRS, AGENT), { at: AGENT, source: "agent" });
  assert.deepEqual(pickMergedAt({}, [], AGENT), { at: AGENT, source: "agent" });
});

test("pickMergedAt is null/null with no PR and no agent time", () => {
  assert.deepEqual(pickMergedAt({}, PRS, null), { at: null, source: null });
});

test("pickMergedAt treats a PR mergedAt that is not a zoned ISO time as absent", () => {
  const prs = [{ number: 12, headRefName: "feat/a", mergedAt: "2026-10-01 10:00" }];
  assert.deepEqual(pickMergedAt({ pr: "12" }, prs, AGENT), { at: AGENT, source: "agent" });
  assert.deepEqual(pickMergedAt({ pr: "12" }, [{ number: 12, mergedAt: null }], null), { at: null, source: null });
});

test("pickMergedAt treats an agent time that is not a zoned ISO time as absent", () => {
  assert.deepEqual(pickMergedAt({}, [], "2026-10-07T04:39:04"), { at: null, source: null });
});
