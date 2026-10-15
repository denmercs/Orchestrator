---
name: grill-me
description: Settle a story plan's big decisions before work starts. Asks the hard-to-reverse questions one at a time with a recommended answer, then batches small defaults as assumption → answer. Use when the user asks to be grilled or a plan has open forks. Test-level grilling comes after this, in grill-tdd.
---

# Grill me

Goal: leave the story plan with no open decision that would be costly to undo later.

## Before asking anything

Read the story plan and the code it points at. If the code answers a question, take the answer and move on. Only ask what the code cannot tell you.

## Sort the open points

- **Major**: hard to reverse once work starts (data shape, public interface, where a boundary sits, what is out of scope, which existing behavior may change).
- **Minor**: cheap to change later, with an obvious default.

## Major decisions: one at a time

For each, in order of how much depends on it:

1. State the question in one or two plain sentences.
2. Give the options with the cost of each.
3. Give your recommended answer and why.
4. Stop and wait. Do not ask the next question until this one is answered.

An answer can change what is major. Re-sort after each reply and drop questions that no longer matter.

## Minor defaults: one batch

Once the major decisions are settled, list the rest as `assumption → answer`, for example `keep the existing file name → yes`. The user corrects only what is wrong; silence means accepted.

## Finish

Write the outcomes into the story plan: each decision with its answer, and each accepted assumption. Remove anything that stayed open or say plainly that it is still open and who owns it. Then hand off to `grill-tdd` to turn the agreed scope into test contracts.

## Do not

- Ask several major questions in one message.
- Ask something you could have found by reading the code.
- Start building.
