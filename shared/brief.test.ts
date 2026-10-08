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
