import assert from "node:assert/strict";
import { test } from "node:test";
import { hasUnread, replyFingerprint } from "./sulti-sidebar-model";

test("replyFingerprint trims and treats null as empty", () => {
  assert.equal(replyFingerprint(null), "");
  assert.equal(replyFingerprint("  hi  "), "hi");
});

test("hasUnread is false with no reply or after the user saw the same line", () => {
  assert.equal(hasUnread(null, ""), false);
  assert.equal(hasUnread("", ""), false);
  assert.equal(hasUnread("hello", "hello"), false);
  assert.equal(hasUnread("  hello ", "hello"), false);
});

test("hasUnread is true when the reply changed", () => {
  assert.equal(hasUnread("new line", ""), true);
  assert.equal(hasUnread("new line", "old line"), true);
});