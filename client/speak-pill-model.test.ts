import assert from "node:assert/strict";
import { test } from "node:test";
import { speakPill } from "./speak-pill-model";

test("speakPill off offers Speak with the muted speaker", () => {
  assert.deepEqual(speakPill(false), {
    title: "Speak this session's replies aloud",
    label: "Speak",
    icon: "VolumeX",
  });
});

test("speakPill on shows Speak · on with the speaker", () => {
  assert.deepEqual(speakPill(true), {
    title: "Replies are spoken. Press to stop speaking them",
    label: "Speak · on",
    icon: "Volume2",
  });
});
