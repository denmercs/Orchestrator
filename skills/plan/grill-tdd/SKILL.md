---
name: grill-tdd
description: Turn an agreed story scope into behavior and test contracts, then order the work as small test-first cycles. Use after grill-me, before implementation. Writes no tests; the tdd skill does the cycles.
---

# Grill for tests

This follows `grill-me`. Scope and the big decisions are already settled there; do not reopen them or ask them again. If a decision turns out to be missing, send the user back to `grill-me` for that one point.

The output is a set of contracts in the story plan, and an order to work them in. No test files are written here.

## 1. One card per behavior

A behavior is something a user or a caller can observe. Write one card for each:

- **Name**: what the thing does, in plain words.
- **Expectation**: `step > step > assertion`, for example `submit empty form > see error > submit stays disabled`.
- **Red**: why the test fails today (missing function, wrong output, no handler).
- **Layer**: unit, integration or end to end, and why that layer is enough.
- **Path**: the test file it will live in, and the production file expected to change.
- **Guard**: the wrong implementation this test must catch.

If a card needs "and" in its name, split it.

## 2. Ask only the test-design forks

Treat these like major decisions: one at a time, with a recommendation, wait for the answer. Typical forks are which layer a behavior is tested at, what is faked and what is real, and what counts as the observable result. Settle small defaults in one `assumption → answer` batch.

## 3. False-positive check

For every card ask: could this test pass without the behavior existing? Look for assertions that hold for any input, mocks that return what the test expects, tests that exercise the fake instead of the code, and expectations too loose to fail. Fix the card's expectation or guard until the answer is no. The `tdd` skill repeats this check against real code: with the change reverted, the test must fail again.

## 4. Order the cycles

List the cards as small cycles, each one behavior, each ending green. Put the simplest behavior that proves the wiring first, and edge cases after. A cycle that cannot fail first is not a cycle; merge it into a neighbor or drop it.

## Finish

Write the cards and cycle order into the story plan, then hand off to `tdd` to run them.
