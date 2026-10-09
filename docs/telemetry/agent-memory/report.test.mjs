// render(data) on a small fixture: four sections, coverage line, every merged story listed, deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { render, outcomeUpdates } from "./report.mjs";

const data = {
  cutoff: "2026-10-09T14:01:28Z",
  stories: [
    { initiative: "z-init", id: "S1", title: "Zed story", hasAgents: false, reviewRounds: 1, fixAttempts: 0 },
    { initiative: "a-init", id: "S2", title: "Alpha story", hasAgents: true, reviewRounds: 3, fixAttempts: 2 },
  ],
  agents: [
    { step: "implement", hasTranscript: true, reads: 4, searches: 2, files: 3, chars: 1000, edited: true, shellCalls: 6, shellChars: 500 },
    { step: "implement", hasTranscript: true, reads: 2, searches: 0, files: 2, chars: 200, edited: false, shellCalls: 2, shellChars: 100 },
    { step: "plan", hasTranscript: true, reads: 1, searches: 1, files: 1, chars: 40, edited: true, shellCalls: 0, shellChars: 0 },
    { step: "plan", hasTranscript: false },
  ],
  repeat: [
    { area: "shared", category: "testing", findings: 4, repeats: 3 },
    { area: "server", category: "types", findings: 2, repeats: 0 },
  ],
  ratios: [1, 2, 3, 4, 5],
};

test("render: sections, coverage, stories, calibration", () => {
  const out = render(data);
  for (const h of ["## Exploration per step", "## Review rounds and fix attempts per story", "## Repeat rate", "## Calibration"]) {
    assert.ok(out.includes(h), h);
  }
  assert.match(out, /Shell calls before first edit/);
  assert.match(out, /keyword guess/);
  // implement: 2 agents, mean reads 3, 1 of 2 reached an edit (50%), shell calls 8
  assert.match(out, /\| implement \| 2 \| 6 \| 2 \| 5 \| 1,200 \| 50% \| 8 \|/);
  // median 3, quartiles 2 and 4 (IQR 2), n 5
  assert.match(out, /median ratio 3\.00, IQR 2\.00 \(2\.00 to 4\.00\), n = 5/);
  assert.match(out, /Stories: 1 with agent records, 1 without/);
  assert.match(out, /Agents: 3 with transcripts, 1 without/);
  assert.ok(out.includes("Alpha story") && out.includes("Zed story"));
  assert.ok(out.indexOf("Alpha story") < out.indexOf("Zed story"), "sorted by initiative, then id");
  assert.match(out, /\| shared \| testing \| 4 \| 3 \| 75% \|/);
  assert.equal(render(data), render(structuredClone(data)));
  assert.ok(!/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/.test(out.replace(data.cutoff, "")), "no other timestamps");
});

test("render: empty calibration does not divide by zero", () => {
  assert.match(render({ ...data, ratios: [] }), /n = 0/);
});

test("outcomeUpdates: only story files without ## Outcome", () => {
  const events = [{ kind: "merged" }];
  const todo = outcomeUpdates("---\nid: S1\n---\n\n## Goal\nx\n", events);
  assert.ok(todo && todo.includes("## Outcome"));
  assert.equal(outcomeUpdates(todo, events), null);
});
