import assert from "node:assert/strict";
import { test } from "node:test";
import { createLineGate, shouldSpeakHere } from "./voice-line-model";

test("a line plays once per lineId, however often its item mounts", () => {
  const gate = createLineGate(1000);
  assert.equal(gate.claim("a", 2000), true);
  assert.equal(gate.claim("a", 2000), false);
  assert.equal(gate.claim("b", 2000), true);
});

test("items older than the mount, seen on scroll-back or at reload, don't play", () => {
  const gate = createLineGate(1000);
  assert.equal(gate.claim("old", 999), false);
  assert.equal(gate.claim("fresh", 1000), true);
});

test("an old item that was refused stays refused, and does not use up a later claim", () => {
  const gate = createLineGate(1000);
  assert.equal(gate.claim("x", 500), false);
  assert.equal(gate.claim("x", 500), false);
});

test("the seen set is bounded, so the oldest lines are forgotten first", () => {
  const gate = createLineGate(0);
  for (let i = 0; i < 300; i++) gate.claim(`l${i}`, 1);
  assert.equal(gate.claim("l299", 1), false);
  assert.equal(gate.claim("l0", 1), true);
});

test("only a phone speaks; the Mac drawer already speaks for itself", () => {
  assert.equal(shouldSpeakHere("android"), true);
  assert.equal(shouldSpeakHere("ios"), true);
  assert.equal(shouldSpeakHere("web"), false);
});
