import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { frontmatter } from "./harness-layout";
import { MAC_POLL_LIVE_MS, maybeRoundNudge, voiceNudgeLive } from "./round-nudge";

const story = (extra = "") => {
  const file = join(mkdtempSync(join(tmpdir(), "nudge-")), "01-story.md");
  writeFileSync(file, `---\nid: S1\ntitle: Story\nstatus: todo\n${extra}---\n\nBody.\n`);
  return file;
};
const nudged = (file: string) => frontmatter(readFileSync(file, "utf8")).round_nudged;

test("maybeRoundNudge records round_nudged only when the send reached someone", async () => {
  const sent: string[] = [];
  const delivered = story();
  await maybeRoundNudge(delivered, 3, "line", (line) => (sent.push(line), true));
  assert.deepEqual(sent, ["line"]);
  assert.equal(nudged(delivered), "3");

  const missed = story();
  await maybeRoundNudge(missed, 3, "line", async () => false);
  assert.equal(nudged(missed), undefined);

  const threw = story();
  await maybeRoundNudge(threw, 3, "line", () => {
    throw new Error("no listener");
  });
  assert.equal(nudged(threw), undefined);

  const rejected = story();
  await maybeRoundNudge(rejected, 3, "line", async () => {
    throw new Error("no listener");
  });
  assert.equal(nudged(rejected), undefined);
});

test("maybeRoundNudge does not send before round 3 or once recorded", async () => {
  let calls = 0;
  const send = () => (calls++, true);
  await maybeRoundNudge(story(), 2, "line", send);
  await maybeRoundNudge(story("round_nudged: 3\n"), 3, "line", send);
  assert.equal(calls, 0);
  // The same send does fire when due, so the zero above is the rule and not a dead mock.
  await maybeRoundNudge(story(), 4, "line", send);
  assert.equal(calls, 1);
});

test("voiceNudgeLive: a live phone or a recent awake Mac poll counts; a stale or never-awake Mac does not", () => {
  const now = 1_000_000;
  // A phone router is awake, whatever the Mac did.
  assert.equal(voiceNudgeLive(now, true, 0), true);
  // The Mac's loop was awake at a poll just now.
  assert.equal(voiceNudgeLive(now, false, now - 1_000), true);
  // The last awake poll is older than the window.
  assert.equal(voiceNudgeLive(now, false, now - MAC_POLL_LIVE_MS), false);
  // An asleep Mac stamps no awake poll, so its last awake poll stays at 0.
  assert.equal(voiceNudgeLive(now, false, 0), false);
});
