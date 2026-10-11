import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ask } from "./claude-cli";
import type { Observation } from "./corrections";
import { CORRECTION_CATEGORIES } from "./memory";
import { haikuClassifier } from "./correction-classifier";

const obs = (id: string, text: string): Observation => ({ id, source: "finding", story: "S1", date: "2026-01-01", link: "l", text });
const batch = [obs("a1", "missing test for parse"), obs("b2", "uses any")];
const context = { areas: ["server", "shared"], phrases: { testing: ["add a regression test"], types: ["avoid any"] } };

function fakeAsk(text: string, costUsd = 0.001) {
  const calls: { system: string; prompt: string }[] = [];
  const ask: Ask = async (system, prompt) => {
    calls.push({ system, prompt });
    return { text, costUsd };
  };
  return { ask, calls };
}

test("asks once with categories, areas, vocabulary and the observations", async () => {
  const { ask, calls } = fakeAsk('{"filings":[]}');
  await haikuClassifier(ask)(batch, context);
  assert.equal(calls.length, 1);
  const { system, prompt } = calls[0];
  for (const category of CORRECTION_CATEGORIES) assert.ok(system.includes(category), category);
  for (const area of context.areas) assert.ok(system.includes(area), area);
  assert.ok(system.includes("add a regression test") && system.includes("avoid any"));
  assert.match(system, /JSON/);
  for (const o of batch) assert.ok(prompt.includes(o.id) && prompt.includes(o.text));
});

test("parses the reply, tolerates a json fence, skips entries without an id or phrase, and passes the cost through", async () => {
  const filings = [
    { id: "a1", category: "testing", area: "server", phrase: "add a regression test" },
    { id: "b2", category: "types", area: null, phrase: "avoid any" },
    { category: "types", area: null, phrase: "no id" },
    { id: "c3", category: "types", area: null },
  ];
  const { ask } = fakeAsk("```json\n" + JSON.stringify({ filings }) + "\n```", 0.0045);
  const result = await haikuClassifier(ask)(batch, context);
  assert.deepEqual(result.filings, [filings[0], filings[1]]);
  assert.equal(result.costUsd, 0.0045);
});

test("an unparseable reply throws a clear error that still reports what it cost", async () => {
  const { ask } = fakeAsk("sorry, I cannot do that", 0.002);
  await assert.rejects(haikuClassifier(ask)(batch, context), (error: Error & { costUsd?: number }) => {
    assert.match(error.message, /not valid JSON/i);
    assert.equal(error.costUsd, 0.002);
    return true;
  });
});

test("a failed ask propagates", async () => {
  const ask: Ask = async () => {
    throw new Error("claude CLI exited 1");
  };
  await assert.rejects(haikuClassifier(ask)(batch, context), /exited 1/);
});
