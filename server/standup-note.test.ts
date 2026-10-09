import assert from "node:assert/strict";
import { test } from "node:test";
import { splitTicket } from "./standup-note";

test("splitTicket: a pipe separator keeps the title clean", () => {
  assert.deepEqual(splitTicket("DCD-123 | Split the board"), { key: "DCD-123", title: "Split the board" });
});

test("splitTicket: the existing dash separators still split", () => {
  assert.deepEqual(splitTicket("DCD-123 — Split the board"), { key: "DCD-123", title: "Split the board" });
  assert.deepEqual(splitTicket("DCD-123: Split the board"), { key: "DCD-123", title: "Split the board" });
});
