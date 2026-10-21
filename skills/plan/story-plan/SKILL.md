---
name: story-plan
description: >
  Default Plan phase for the Story pipeline. Writes .harness/state.md with
  Problem, Approach, Scope, First step and the status marker. TDD-shaped:
  the first step for a code change names the failing test. Blocks a story
  that is too big to plan in roughly twenty lines. Not for architecture
  (use arch-plan) or multi-epic roadmaps (use major-feature-roadmap).
---

# story-plan

The Plan phase for one Jira story. Fill `.harness/state.md` with these five sections, then stop.

## Problem

One sentence. The user's problem in their words, not a restatement of the ticket title.

## Approach

One paragraph. The shortest path that solves it. No alternatives, no "we could also".

## Scope

Two short bullet lists.

- **In** — what this story changes.
- **Not in** — what it deliberately will not change. This is the important list; it keeps Implement from wandering.

## First step

One concrete thing Implement can start on.

- If the change is code: name the first failing test. File, test name, one-sentence assertion.
- If the change is not code (docs, config, prose): name the file to open and the exact edit.

## Status marker

End the file with the Plan handoff line the pipeline reads (`plan-done`, or `plan-blocked` with a one-line reason when the story is too big — see below).

## Length and too-big

The whole plan should fit in roughly twenty lines. If it will not, don't write a vague plan. Write `plan-blocked` with one sentence naming what to split, and stop. Splitting beats a plan the Implement phase will misread.

## Voice

Write it like a Slack message to a teammate who already knows the project. Short sentences, concrete nouns, no "we will leverage" or "this ensures". If a sentence could open a product blog, cut it.
