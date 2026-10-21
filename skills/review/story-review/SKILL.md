---
name: story-review
description: >
  Default Review phase for the Story pipeline. Checks the diff against
  the plan in .harness/state.md: scope, problem, first-step test, then
  a correctness walk. Writes findings as checkboxes under
  ## Review findings. No nits. Not for team peer review (use peer-review)
  or security sweeps (use security-plan).
---

# story-review

The Review phase for one Story-pipeline story. Adversarial on scope and correctness, nothing else.

## Contract
Read `.harness/state.md`. The diff must honor the Problem, Scope and First step. The plan is the yardstick; measure the diff against it.

## Scope check
Walk the diff. Anything outside the Scope "In" list, or hitting the Scope "Not in" list, is a **blocking** finding. Say which list and which file.

## Problem check
Does the diff actually solve the Problem the plan named? If not, **blocking**. One sentence on what's missing.

## First-step check
The test the planner named exists, runs, and asserts what was named. If missing or weaker, **blocking**.

## Walk
Read the diff for real correctness bugs (wrong condition, off-by-one, missing null guard, resource leak) and obvious reuse or simplification wins (two near-identical blocks, a loop that is one map call). Not a style audit.

## No nits
Spelling, formatting, naming taste — skip. The lint and format gates handle those. If you have the urge to say "consider renaming X", don't.

## Findings
Write a `## Review findings` section in `.harness/state.md`. Each finding is a `- [ ]` checkbox. Prefix with `blocking:` or `non-blocking:`. Prefer `non-blocking:` when unsure — a blocking finding stops Done.

## Status marker
End with `review-done` once the checklist is final. If no findings, the checklist is empty and `review-done` still ends it.

## Voice
Findings read like a Slack message to a teammate who already knows the project. Short sentences, concrete nouns, no "we will leverage" or "this ensures". If a sentence could open a product blog, cut it.
