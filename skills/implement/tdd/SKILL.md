---
name: tdd
description: Test-driven development, one behavior per cycle - failing test, smallest change, revert and fail again, restore. Use when implementing from the story plan's cycles or doing ad-hoc TDD. Contract grilling belongs to grill-tdd, not this skill.
---

# Test-driven development

Work one behavior at a time. Each cycle is complete before the next starts. If the story plan has no contract cards yet, stop and run `grill-tdd` first; deciding what to test is not done here.

## A cycle

1. **Check what is there.** A half-finished cycle may already be in the tree. Read it before writing anything.
2. **Write the test** for this one behavior only.
3. **See it fail (RED).** Run the narrowest command that covers it. Confirm it fails for the reason the card expected, not a typo, import error or missing fixture. A test that fails for the wrong reason proves nothing.
4. **Make the smallest change that passes.** Do not add what the next cycle will need.
5. **See it pass.**
6. **Revert and fail again.** Undo only the production change, run the test, confirm it fails the same way. Restore the change, confirm it passes. If it still passes with the change gone, the test is a false positive: fix the test, not the code.
7. **Record the evidence.** One line in the evidence log: the command, and `fail → pass`.

## Rules

- **Never weaken a test to get green.** No loosened assertion, no skipped case, no deleted expectation. If the test is wrong, say why, change it deliberately, and redo steps 3 to 6.
- **Refactor only when green**, and re-run after each change. A refactor that needs a test edit is a behavior change; make it a new cycle.
- **One behavior per test.** If a test needs "and", split it.
- **Test through the public interface**, not private details, so refactors do not break tests.
- If the code is not testable without a big change, stop and tell the user rather than bending the test.

## Report

Say per cycle: the test, the RED reason, and the result after revert and restore. If you cannot go on, say which step failed and why.
