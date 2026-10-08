import assert from "node:assert/strict";
import { test } from "node:test";
import { briefCiLog } from "./pr-checks";

// `gh run view --log-failed` prefixes every line with `<job>\t<step>\t<timestamp> `.
const prefix = (line: string) => `test\tRun npm test\t2026-10-08T12:00:00.1234567Z ${line}`;

test("briefCiLog strips gh prefixes and keeps a failure far from the end", () => {
  const log = [
    "TAP version 13",
    "# Subtest: breaks",
    "not ok 1 - breaks",
    "  ---",
    "  location: '/repo/a.test.ts:3:1'",
    "  error: 'Expected values to be strictly equal'",
    "  stack: |-",
    "    at TestContext.<anonymous> (/repo/a.test.ts:4:10)",
    "  ...",
    ...Array.from({ length: 200 }, (_, i) => `# Subtest: passes ${i}\nok ${i + 2} - passes ${i}`).join("\n").split("\n"),
    "1..201",
    "# tests 201",
    "# pass 200",
    "# fail 1",
    "# duration_ms 50",
  ]
    .map(prefix)
    .join("\n");
  assert.ok(log.indexOf("not ok 1 - breaks") < log.length - 4000);

  const brief = briefCiLog(log);

  assert.ok(brief.includes("not ok 1 - breaks"));
  assert.ok(brief.includes("  error: 'Expected values to be strictly equal'"));
  assert.ok(brief.includes("# fail 1"));
  assert.ok(!brief.includes("Run npm test"));
  assert.ok(!brief.includes("2026-10-08T"));
  assert.ok(!brief.includes("stack:"));
});
