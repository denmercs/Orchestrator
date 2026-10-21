---
name: story-impl
description: >
  Default Implement phase for the Story pipeline. Reads the plan from
  .harness/state.md and runs it: red test, green code, verify, status
  marker. No re-planning, no bonus refactors. Full suite must be green
  before handoff. Non-code stories skip red/green and do the named edit.
  Not for debugging-heavy work (use bugfix) or UI parity (use visual-parity-check).
---

# story-impl

The Implement phase for one Story-pipeline story. Follow the plan the Plan phase wrote; don't rewrite it.

## Contract
Read `.harness/state.md`. The Problem, Approach, Scope and First step are the contract. Don't re-plan. If the plan is wrong, write a one-line note under `## Status` and stop — the user re-plans.

## Red
Open the test file the planner named under First step. Write the test exactly as named. Run it. Watch it fail for the right reason — not a syntax error, not a missing import. If it passes immediately, the test is wrong; fix the test, not the code.

## Green
Make it pass with the smallest change that works. Touch only files that Scope "In" allows. No bonus refactors, no "while I'm here".

## Refactor
Skip unless the change you just made introduced obvious duplication or an obviously ugly shape. One pass, then stop. Not a style audit.

## Verify
Run the one test again. Then run the full test suite. Both green. If the full suite surfaces a failure the plan didn't anticipate, write a one-line note under `## Status` and stop.

## Non-code stories
If the plan's First step named a file-and-edit instead of a test (docs, config, prose), skip Red and Green. Make the edit. Verify by rereading the file end to end.

## Status marker
End with the Implement handoff line the pipeline reads.

## Voice
Write any notes you add to `.harness/state.md` like a Slack message to a teammate who already knows the project. Short sentences, concrete nouns, no "we will leverage" or "this ensures". If a sentence could open a product blog, cut it.
