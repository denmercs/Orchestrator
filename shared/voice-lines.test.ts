import assert from "node:assert/strict";
import { test } from "node:test";
import { pickFirstLine, sentLine, spokenLine } from "./voice-lines";

test("pickFirstLine names up to five sessions, or says none are open", () => {
  assert.equal(pickFirstLine(["a", "b"]), "Pick a session first: say switch to, then a name. Sessions: a, b.");
  assert.equal(pickFirstLine(["a", "b", "c", "d", "e", "f"]), "Pick a session first: say switch to, then a name. Sessions: a, b, c, d, e, and more.");
  assert.equal(pickFirstLine([]), "Pick a session first: say switch to, then a name. No sessions are open.");
});

test("lines are whole sentences, and replies are spoken as their first plain paragraph", () => {
  assert.equal(sentLine("docs"), "Sent to docs.");
  assert.equal(spokenLine("```ts\nx\n```\n**Done**, see `a.ts`.\n\nMore."), "Done, see a.ts.");
});
