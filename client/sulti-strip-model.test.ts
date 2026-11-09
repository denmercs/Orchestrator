import assert from "node:assert/strict";
import { test } from "node:test";
import { canSend, previewText, statusLine } from "./sulti-strip-model";

test("previewText says there is no reply yet when the reply is null", () => {
  assert.equal(previewText(null), "No reply from Sulti yet");
});

test("previewText returns the trimmed plain-text reply", () => {
  assert.equal(previewText("  Two agents are running.\n"), "Two agents are running.");
});

test("previewText treats a blank reply as no reply", () => {
  assert.equal(previewText("   \n "), "No reply from Sulti yet");
});

test("statusLine joins the spoken lines", () => {
  assert.equal(statusLine({ spoken: ["One", "Two"], note: "ignored" }), "One Two");
});

test("statusLine falls back to the note, then to empty", () => {
  assert.equal(statusLine({ spoken: [], note: "Queued" }), "Queued");
  assert.equal(statusLine({ spoken: [], note: null }), "");
});

test("canSend needs non-blank text and no send in flight", () => {
  assert.equal(canSend("hello", false), true);
  assert.equal(canSend("   ", false), false);
  assert.equal(canSend("", false), false);
  assert.equal(canSend("hello", true), false);
});
