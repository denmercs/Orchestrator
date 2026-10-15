---
name: prototype
description: Build throwaway code during planning to answer one design question, then delete it and record the answer. Use when a plan decision depends on how something behaves and reading code cannot settle it. Not for production code.
---

# Prototype

A prototype answers one question so the plan can decide. It is not a first draft of the feature.

## Steps

1. **Write the question down.** One sentence, answerable with yes/no or a choice between named options. If you have two questions, make two prototypes.
2. **Say what the answer will look like** before building, so you know when to stop.
3. **Build the least that can answer it.** Hardcode inputs, skip error handling, ignore style. For a state or logic question, a small runnable script that prints each step is enough. For a look-and-feel question, make two or three clearly different variations viewable from one place.
4. **Keep it apart from production code.** Put it in its own folder, outside the source tree and the test suites, and import nothing from it into real code.
5. **One command runs it.** Write that command at the top of the file.
6. **Store nothing.** No real data, no database writes, no files outside its own folder, no network calls to live systems.
7. **Run it and read what happens.** Let the user try it when the question is about feel.

## Afterwards

- Put the answer, and the evidence for it, into the story plan's open decisions, and mark the question settled.
- Delete the prototype. If something in it is worth keeping, rewrite it test-first through `tdd`; do not promote the throwaway.
- If the answer changes scope, return to `grill-me` for that decision.
