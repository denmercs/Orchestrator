import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TESTING_SKILL, TESTING_SKILL_PATH } from "../shared/testing-skill";
import { prepareTestingSkill, repoTestingSkill } from "./testing-skill";

// A throwaway git repo, optionally with a committed-style `.orchestrator/pipeline.json`.
function repo(pipeline?: object) {
  const dir = mkdtempSync(join(tmpdir(), "testing-skill-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (pipeline) {
    mkdirSync(join(dir, ".orchestrator"), { recursive: true });
    writeFileSync(join(dir, ".orchestrator", "pipeline.json"), JSON.stringify(pipeline));
  }
  return dir;
}

test("Implement and Review get the built-in skill, written under .harness and kept out of git", async () => {
  const dir = repo();
  try {
    for (const step of ["implement", "review"]) {
      assert.deepEqual(await prepareTestingSkill(dir, step), { path: TESTING_SKILL_PATH });
    }
    assert.equal(readFileSync(join(dir, TESTING_SKILL_PATH), "utf8"), TESTING_SKILL);
    assert.match(readFileSync(join(dir, ".git", "info", "exclude"), "utf8"), /^\.harness\/$/m);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Plan, Diagnose, PR and Fix CI get nothing and nothing is written", async () => {
  const dir = repo();
  try {
    for (const step of ["plan", "diagnose", "pr", "fix", "done"]) {
      assert.deepEqual(await prepareTestingSkill(dir, step), {});
    }
    assert.equal(existsSync(join(dir, TESTING_SKILL_PATH)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a repo's own skill file wins, and the built-in one is not written", async () => {
  const dir = repo({ testingSkill: ".orchestrator/testing.md" });
  try {
    writeFileSync(join(dir, ".orchestrator", "testing.md"), "# Our tests\n");
    assert.equal(repoTestingSkill(dir), ".orchestrator/testing.md");
    assert.deepEqual(await prepareTestingSkill(dir, "implement"), { path: ".orchestrator/testing.md" });
    assert.equal(existsSync(join(dir, TESTING_SKILL_PATH)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("testingSkill false turns it off for the repo", async () => {
  const dir = repo({ testingSkill: false, maxFixes: 0 });
  try {
    assert.deepEqual(await prepareTestingSkill(dir, "review"), {});
    assert.equal(existsSync(join(dir, TESTING_SKILL_PATH)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a named file that is missing falls back to the built-in skill with a warning", async () => {
  const dir = repo({ testingSkill: "docs/nope.md" });
  try {
    const got = await prepareTestingSkill(dir, "implement");
    assert.equal(got.path, TESTING_SKILL_PATH);
    assert.match(got.warning ?? "", /docs\/nope\.md is not a file/);
    assert.equal(readFileSync(join(dir, TESTING_SKILL_PATH), "utf8"), TESTING_SKILL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a broken pipeline.json keeps the built-in skill", async () => {
  const dir = repo();
  try {
    mkdirSync(join(dir, ".orchestrator"), { recursive: true });
    writeFileSync(join(dir, ".orchestrator", "pipeline.json"), "{ not json");
    assert.equal(repoTestingSkill(dir), undefined);
    assert.deepEqual(await prepareTestingSkill(dir, "implement"), { path: TESTING_SKILL_PATH });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
