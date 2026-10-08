import assert from "node:assert/strict";
import { test } from "node:test";
import { pickLines } from "./brief";

// Real `node --test` output when piped (TAP): one passing test, a failing child, and its
// `subtestsFailed` parent.
const TAP_FAILING = `TAP version 13
# Subtest: adds
ok 1 - adds
  ---
  duration_ms: 0.298916
  type: 'test'
  ...
# Subtest: parent
    # Subtest: child breaks
    not ok 1 - child breaks
      ---
      duration_ms: 0.2955
      type: 'test'
      location: '/tmp/t.test.mjs:5:11'
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly equal:

        2 !== 3

      code: 'ERR_ASSERTION'
      name: 'AssertionError'
      expected: 3
      actual: 2
      operator: 'strictEqual'
      stack: |-
        TestContext.<anonymous> (file:///tmp/t.test.mjs:5:45)
        Test.runInAsyncScope (node:async_hooks:214:14)
      ...
    1..1
not ok 2 - parent
  ---
  duration_ms: 0.42825
  type: 'test'
  location: '/tmp/t.test.mjs:4:1'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..2
# tests 3
# suites 0
# pass 1
# fail 2
# cancelled 0
# skipped 0
# todo 0
# duration_ms 44.717792
`;

const TAP_PASSING = `TAP version 13
# Subtest: ok
ok 1 - ok
  ---
  duration_ms: 0.319959
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 47.003625
`;

test("pickLines: TAP failure keeps the failing test, its assertion and the summary", () => {
  assert.deepEqual(pickLines(TAP_FAILING), [
    "    not ok 1 - child breaks",
    "      location: '/tmp/t.test.mjs:5:11'",
    "      error: |-",
    "        Expected values to be strictly equal:",
    "",
    "        2 !== 3",
    "",
    "      expected: 3",
    "      actual: 2",
    "      operator: 'strictEqual'",
    "# tests 3",
    "# suites 0",
    "# pass 1",
    "# fail 2",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 44.717792",
  ]);
});

test("pickLines: TAP pass returns only the summary", () => {
  assert.deepEqual(pickLines(TAP_PASSING), [
    "# tests 1",
    "# suites 0",
    "# pass 1",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 47.003625",
  ]);
});

// Real `node --test --test-reporter=spec` output with FORCE_COLOR set, so the colour codes are kept.
const SPEC_FAILING = [
  "\x1b[32m✔ adds \x1b[90m(0.283916ms)\x1b[39m\x1b[39m",
  "▶ parent",
  "  \x1b[31m✖ child breaks \x1b[90m(0.298167ms)\x1b[39m\x1b[39m",
  "\x1b[31m✖ parent \x1b[90m(0.434791ms)\x1b[39m\x1b[39m",
  "\x1b[34mℹ tests 3\x1b[39m",
  "\x1b[34mℹ suites 0\x1b[39m",
  "\x1b[34mℹ pass 1\x1b[39m",
  "\x1b[34mℹ fail 2\x1b[39m",
  "\x1b[34mℹ duration_ms 40.440583\x1b[39m",
  "",
  "\x1b[31m✖ failing tests:\x1b[39m",
  "",
  "test at t.test.mjs:4:39",
  "\x1b[31m✖ child breaks \x1b[90m(0.298167ms)\x1b[39m\x1b[39m",
  "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
  "  ",
  "  2 !== 3",
  "  ",
  "      at TestContext.<anonymous> (file:///private/tmp/s8spec/t.test.mjs:4:73)",
  "      at Test.runInAsyncScope (node:async_hooks:214:14) {",
  "    generatedMessage: true,",
  "    code: 'ERR_ASSERTION',",
  "    actual: 2,",
  "    expected: 3,",
  "    operator: 'strictEqual',",
  "    diff: 'simple'",
  "  }",
  "",
].join("\n");

test("pickLines: spec failure keeps the failing tests section without stack frames, then the summary", () => {
  assert.deepEqual(pickLines(SPEC_FAILING), [
    "✖ failing tests:",
    "",
    "test at t.test.mjs:4:39",
    "✖ child breaks (0.298167ms)",
    "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
    "  ",
    "  2 !== 3",
    "  ",
    "    generatedMessage: true,",
    "    code: 'ERR_ASSERTION',",
    "    actual: 2,",
    "    expected: 3,",
    "    operator: 'strictEqual',",
    "    diff: 'simple'",
    "  }",
    "ℹ tests 3",
    "ℹ suites 0",
    "ℹ pass 1",
    "ℹ fail 2",
    "ℹ duration_ms 40.440583",
  ]);
});

test("pickLines: unrecognised output falls back to the last max lines", () => {
  const output = Array.from({ length: 100 }, (_, i) => `\x1b[1mline ${i}\x1b[22m`).join("\n") + "\n";
  assert.deepEqual(pickLines(output, 5), ["line 95", "line 96", "line 97", "line 98", "line 99"]);
});

test("pickLines: failures past the cap are cut with a note, the summary is kept", () => {
  const failures = Array.from(
    { length: 40 },
    (_, i) =>
      `not ok ${i + 1} - case ${i}\n  ---\n  location: '/tmp/t.test.mjs:${i}:1'\n  error: 'boom'\n` +
      `  expected: 1\n  actual: 2\n  stack: |-\n    x\n  ...`,
  ).join("\n");
  const picked = pickLines(`TAP version 13\n${failures}\n1..40\n# tests 40\n# pass 0\n# fail 40\n`);
  assert.equal(picked.length, 80);
  assert.equal(picked[0], "not ok 1 - case 0");
  assert.deepEqual(picked.slice(-4), ["# tests 40", "# pass 0", "# fail 40", "… 124 more lines in the log"]);
});
