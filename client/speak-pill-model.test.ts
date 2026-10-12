import assert from "node:assert/strict";
import { test } from "node:test";
import { nextSpeakMode, speakPill } from "./speak-pill-model";

test("speakPill off offers Speak with the muted speaker", () => {
  assert.deepEqual(speakPill("off"), {
    title: "Speak this session's replies aloud",
    label: "Speak",
    icon: "VolumeX",
  });
});

test("speakPill short shows Speak · short and offers full next", () => {
  assert.deepEqual(speakPill("short"), {
    title: "The first line of each reply is spoken. Press to speak the full reply",
    label: "Speak · short",
    icon: "Volume2",
  });
});

test("speakPill full shows Speak · full and offers off next", () => {
  assert.deepEqual(speakPill("full"), {
    title: "Whole replies are spoken. Press to stop speaking them",
    label: "Speak · full",
    icon: "Volume2",
  });
});

test("a press cycles off, short, full, off", () => {
  assert.equal(nextSpeakMode("off"), "short");
  assert.equal(nextSpeakMode("short"), "full");
  assert.equal(nextSpeakMode("full"), "off");
});
