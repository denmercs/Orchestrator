import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readStories } from "./harness-layout";

test("readStories returns skill_warnings as skillWarnings, empty when unset", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-layout-"));
  try {
    const stories = join(dir, "stories");
    mkdirSync(stories);
    writeFileSync(join(stories, "01-a.md"), "---\nid: S1\ntitle: A\nstatus: todo\nskill_warnings: tdd not found · copy failed\n---\n");
    writeFileSync(join(stories, "02-b.md"), "---\nid: S2\ntitle: B\nstatus: todo\n---\n");
    assert.deepEqual(
      readStories(dir).map((story) => story.skillWarnings),
      ["tdd not found · copy failed", ""],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
