import assert from "node:assert/strict";
import { test } from "node:test";
import type { EpicBoardState, EpicStory } from "./orchestration";
import { initiativeStatus, stepBar } from "./story-steps";

function story(fields: Partial<EpicStory> = {}): EpicStory {
  return {
    id: "S1",
    title: "Story S1",
    status: "todo",
    dependsOn: [],
    blockedBy: "",
    blockedReason: "",
    blockedFrom: "",
    skillWarnings: "",
    discoveredFrom: "",
    pr: null,
    ci: "",
    workspace: "",
    agent: "",
    ready: false,
    track: "plan",
    ...fields,
  };
}

const segments = (fields: Partial<EpicStory>) => stepBar(story(fields), "plan").segments;

test("stepBar segments: todo, planning and awaiting-approval sit on Plan", () => {
  assert.deepEqual(segments({ status: "todo" }), ["todo", "todo", "todo", "todo", "todo"]);
  assert.deepEqual(segments({ status: "planning" }), ["now", "todo", "todo", "todo", "todo"]);
  assert.deepEqual(segments({ status: "awaiting-approval" }), ["gate", "todo", "todo", "todo", "todo"]);
});

test("stepBar segments: implementing and reviewing mark earlier steps done", () => {
  assert.deepEqual(segments({ status: "implementing" }), ["done", "now", "todo", "todo", "todo"]);
  assert.deepEqual(segments({ status: "reviewing" }), ["done", "done", "now", "todo", "todo"]);
});

test("stepBar segments: pr-open watches CI, and a green PR is a gate", () => {
  const watching = ["done", "done", "done", "done", "now"];
  assert.deepEqual(segments({ status: "pr-open", ci: "pending", pr: 42 }), watching);
  assert.deepEqual(segments({ status: "pr-open", ci: "", pr: 42 }), watching);
  assert.deepEqual(segments({ status: "pr-open", ci: "failing", pr: 42 }), watching);
  assert.deepEqual(segments({ status: "pr-open", ci: "green", pr: 42 }), ["done", "done", "done", "done", "gate"]);
});

test("stepBar segments: blocked puts a gate on the step it was blocked from", () => {
  const blocked = (blockedFrom: string) => segments({ status: "blocked", blockedFrom });
  assert.deepEqual(blocked("planning"), ["gate", "todo", "todo", "todo", "todo"]);
  assert.deepEqual(blocked("implementing"), ["done", "gate", "todo", "todo", "todo"]);
  assert.deepEqual(blocked("reviewing"), ["done", "done", "gate", "todo", "todo"]);
  assert.deepEqual(blocked("pr-open"), ["done", "done", "done", "done", "gate"]);
  assert.deepEqual(blocked(""), ["gate", "todo", "todo", "todo", "todo"]);
  assert.deepEqual(blocked("something-else"), ["gate", "todo", "todo", "todo", "todo"]);
});

test("stepBar segments: merged is done all the way", () => {
  assert.deepEqual(segments({ status: "merged", pr: 40 }), ["done", "done", "done", "done", "done"]);
});

test("stepBar labels: the first step is Plan, or Diagnose on the diagnose track", () => {
  assert.deepEqual(stepBar(story(), "plan").labels, ["Plan", "Implement", "Review", "PR", "CI watch"]);
  assert.deepEqual(stepBar(story(), "diagnose").labels, ["Diagnose", "Implement", "Review", "PR", "CI watch"]);
});

const text = (fields: Partial<EpicStory>, track: "plan" | "diagnose" = "plan", stories?: EpicStory[]) => {
  const { sub, detail, cta } = stepBar(story(fields), track, stories);
  return { sub, detail, cta };
};

test("stepBar text: a ready todo story can start", () => {
  assert.deepEqual(text({ status: "todo", ready: true }), {
    sub: "Ready to start",
    detail: "No blockers",
    cta: "Start agent",
  });
});

test("stepBar text: a waiting todo story names the first unmerged dependency in the board", () => {
  const board = [story({ id: "S2", status: "merged", pr: 7 }), story({ id: "S3", status: "implementing" })];
  assert.deepEqual(text({ status: "todo", dependsOn: ["S2", "S3"] }, "plan", board), {
    sub: "after S3",
    detail: "Waiting on S3",
    cta: "View plan",
  });
});

test("stepBar text: a waiting todo story without board context names its first dependency", () => {
  assert.deepEqual(text({ status: "todo", dependsOn: ["S2", "S3"] }), {
    sub: "after S2",
    detail: "Waiting on S2",
    cta: "View plan",
  });
});

test("stepBar text: a waiting todo story with no dependencies is just Waiting", () => {
  assert.deepEqual(text({ status: "todo" }), { sub: "Waiting", detail: "Waiting", cta: "View plan" });
});

test("stepBar text: planning reads Planning, or Diagnosing on the diagnose track", () => {
  assert.deepEqual(text({ status: "planning" }), {
    sub: "Planning",
    detail: "Writing the plan",
    cta: "Open session",
  });
  assert.deepEqual(text({ status: "planning" }, "diagnose"), {
    sub: "Diagnosing",
    detail: "Diagnosing the bug",
    cta: "Open session",
  });
});

test("stepBar text: awaiting-approval asks for a plan review, or a diagnosis review", () => {
  assert.deepEqual(text({ status: "awaiting-approval" }), {
    sub: "Plan awaiting approval",
    detail: "Plan ready for your approval",
    cta: "Review plan",
  });
  assert.deepEqual(text({ status: "awaiting-approval" }, "diagnose").sub, "Diagnosis awaiting approval");
});

test("stepBar text: implementing and reviewing open the session", () => {
  assert.deepEqual(text({ status: "implementing" }), {
    sub: "Implementing",
    detail: "Implement",
    cta: "Open session",
  });
  assert.deepEqual(text({ status: "reviewing" }), { sub: "Reviewing", detail: "Review", cta: "Open session" });
});

test("stepBar text: pr-open follows CI", () => {
  const running = { sub: "CI running", detail: "PR #42 · CI running", cta: "Open PR" };
  assert.deepEqual(text({ status: "pr-open", ci: "pending", pr: 42 }), running);
  assert.deepEqual(text({ status: "pr-open", ci: "", pr: 42 }), running);
  assert.deepEqual(text({ status: "pr-open", ci: "none", pr: 42 }), running);
  assert.deepEqual(text({ status: "pr-open", ci: "failing", pr: 42 }), {
    sub: "CI failing",
    detail: "PR #42 · CI failing, fixing",
    cta: "Open session",
  });
  assert.deepEqual(text({ status: "pr-open", ci: "green", pr: 42 }), {
    sub: "Ready to merge",
    detail: "PR #42 passed Review and CI",
    cta: "Review & merge",
  });
});

test("stepBar text: pr-open without a PR number says PR, not PR #", () => {
  assert.equal(text({ status: "pr-open", ci: "pending" }).detail, "PR · CI running");
  assert.equal(text({ status: "pr-open", ci: "green" }).detail, "PR passed Review and CI");
});

test("stepBar text: blocked shows the reason, or Blocked without one", () => {
  assert.deepEqual(text({ status: "blocked", blockedReason: "Needs a Jira key" }), {
    sub: "Stuck · no progress",
    detail: "Needs a Jira key",
    cta: "Open session",
  });
  assert.equal(text({ status: "blocked" }).detail, "Blocked");
});

test("stepBar text: merged names the PR when there is one", () => {
  assert.deepEqual(text({ status: "merged", pr: 40 }), {
    sub: "Merged #40",
    detail: "Merged in #40",
    cta: "Open PR",
  });
  assert.deepEqual(text({ status: "merged" }), { sub: "Merged", detail: "Merged in main", cta: "Open PR" });
});

test("stepBar text: an unknown status shows the raw status", () => {
  assert.deepEqual(text({ status: "paused" }), { sub: "paused", detail: "paused", cta: "Open session" });
});

const PLAN = { warnings: [], jira: false, status: "agreed" };

function boardState(stories: EpicStory[], plan: EpicBoardState["plan"] = PLAN): EpicBoardState {
  return {
    epic: { id: "1", title: "Header and tabs", dir: "phases/1-header-and-tabs" },
    initiative: "Orchestration Redesign",
    initiativeSlug: "orchestration-redesign",
    loop: "on",
    plan,
    tracker: "local",
    next: { story: null, reason: "" },
    repoUrl: "",
    stories,
  };
}

test("initiativeStatus: no stories reads Needs plan without a plan, Planning with one", () => {
  assert.equal(initiativeStatus(boardState([], null)), "Needs plan");
  assert.equal(initiativeStatus(boardState([])), "Planning");
});

test("initiativeStatus: every story merged is Done", () => {
  assert.equal(initiativeStatus(boardState([story({ status: "merged" }), story({ id: "S2", status: "merged" })])), "Done");
});

test("initiativeStatus: a plan gate, a green PR or a blocked story Needs you, ahead of work in progress", () => {
  const busy = story({ id: "S9", status: "implementing" });
  for (const gate of [
    story({ status: "awaiting-approval" }),
    story({ status: "pr-open", ci: "green", pr: 42 }),
    story({ status: "blocked" }),
  ]) {
    assert.equal(initiativeStatus(boardState([busy, gate])), "Needs you");
  }
});

test("initiativeStatus: any story planning, implementing, reviewing or with a PR open is In progress", () => {
  for (const status of ["planning", "implementing", "reviewing", "pr-open"]) {
    const ready = story({ id: "S2", status: "todo", ready: true });
    assert.equal(initiativeStatus(boardState([ready, story({ status, ci: "pending" })])), "In progress", status);
  }
});

test("initiativeStatus: a ready todo story with nothing running is Ready", () => {
  const merged = story({ id: "S2", status: "merged" });
  assert.equal(initiativeStatus(boardState([merged, story({ status: "todo", ready: true })])), "Ready");
});

test("initiativeStatus: anything else falls back to In progress", () => {
  assert.equal(initiativeStatus(boardState([story({ status: "todo", dependsOn: ["S2"] })])), "In progress");
});
