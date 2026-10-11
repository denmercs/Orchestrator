import assert from "node:assert/strict";
import { test } from "node:test";
import { recapPill } from "./recap-pill-model";

test("recapPill offers Recap on an idle Claude session", () => {
  assert.deepEqual(recapPill({ provider: "claude", status: "idle" }), {
    title: "Recap this session (/recap)",
    label: "Recap",
    disabled: false,
  });
});

test("recapPill is disabled while the turn runs", () => {
  assert.equal(recapPill({ provider: "claude", status: "running" })?.disabled, true);
});

test("recapPill is absent for providers without /recap", () => {
  assert.equal(recapPill({ provider: "codex", status: "idle" }), null);
});
