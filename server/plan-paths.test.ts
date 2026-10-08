import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { missingPaths, planPaths } from "./plan-paths";

test("planPaths: a bold Files label, wrapped onto a second line, with (new) marked", () => {
  const plan = [
    "Approach: change `server/ignored.ts` here.",
    "",
    "**Files:** `server/plan-paths.ts` (new), `server/plan-paths.test.ts` (new), `shared/story-method.ts`,",
    "`server/initiative-loop.ts`",
    "**Commands:** `node --test server/x.test.ts`",
  ].join("\n");

  assert.deepEqual(planPaths(plan), [
    { path: "server/plan-paths.ts", isNew: true },
    { path: "server/plan-paths.test.ts", isNew: true },
    { path: "shared/story-method.ts", isNew: false },
    { path: "server/initiative-loop.ts", isNew: false },
  ]);
});

test("planPaths: Calls keeps paths and skips function names, identifiers and node: modules", () => {
  const plan =
    "**Calls:** `readSection`, `stepPrompt`, the `STEPS.plan` / `RULES` / `context()` text in `shared/story-method.ts`; " +
    "`existsSync` from `node:fs`; `foo()` in server/foo.ts:12";

  assert.deepEqual(planPaths(plan), [
    { path: "shared/story-method.ts", isNew: false },
    { path: "server/foo.ts", isNew: false },
  ]);
});

test("planPaths: a plain label with bullets under it, until a blank line", () => {
  const plan = [
    "- Files:",
    "  - `server/a.ts:40` (new)",
    "  - README.md",
    "",
    "- `server/after-blank.ts`",
    "Calls:",
    "- `shared/b.ts` — `doThing()`",
    "## Next",
    "- `server/after-heading.ts`",
  ].join("\n");

  assert.deepEqual(planPaths(plan), [
    { path: "server/a.ts", isNew: true },
    { path: "README.md", isNew: false },
    { path: "shared/b.ts", isNew: false },
  ]);
});

test("planPaths: no Files or Calls lines gives nothing", () => {
  assert.deepEqual(planPaths("Approach: edit `server/a.ts`.\n**Out of scope:** `server/b.ts`"), []);
  assert.deepEqual(planPaths(""), []);
});

test("missingPaths: only existing-path entries missing on disk, relative to the worktree, once each", () => {
  const worktree = mkdtempSync(join(tmpdir(), "plan-paths-"));
  try {
    mkdirSync(join(worktree, "server"));
    writeFileSync(join(worktree, "server/here.ts"), "");
    const absent = join(worktree, "nowhere/abs.ts");

    assert.deepEqual(
      missingPaths(
        [
          { path: "server/here.ts", isNew: false },
          { path: "server/gone.ts", isNew: false },
          { path: "server/brand-new.ts", isNew: true },
          { path: "server/gone.ts", isNew: false },
          { path: join(worktree, "server/here.ts"), isNew: false },
          { path: absent, isNew: false },
        ],
        worktree,
      ),
      ["server/gone.ts", absent],
    );
    assert.deepEqual(missingPaths([], worktree), []);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});
