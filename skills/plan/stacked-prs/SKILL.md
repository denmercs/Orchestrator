---
name: stacked-prs
description: >
  Size and order pull requests (PRs) so each one is one idea a reviewer can hold: about 500 source lines,
  tests excluded, with a justification or a split above 1,000. Covers planning a stack of PRs, testing at
  the tip, moving fixes to their layer, restacking after a squash-merge, and the PR body. Use when planning a
  story or epic, when a branch grows past one idea, or as an Orchestrator Plan extra.
---

# Stacked PRs

## The size rule

**One idea per PR.** An idea is one concept a reviewer has to understand to approve the PR: a new data
model, a new screen, a refactor of one module. If the description needs "and also", it is two ideas.

Count **source lines only**, added plus deleted:

- About **500** per PR is the target.
- Above **1,000**, the PR body must say why this is still one idea, or the PR is split.
- Tests, snapshots, lockfiles and generated files never count.

Count with the skill's helper (it reads `git diff --numstat <base>...<head>`). If the first path is missing, use `~/.claude/skills/stacked-prs/scripts/count-lines.mjs`:

```sh
node .claude/skills/stacked-prs/scripts/count-lines.mjs origin/main HEAD
node .claude/skills/stacked-prs/scripts/count-lines.mjs origin/main HEAD --skip "*.svg" --skip "fixtures/**"
```

It prints source, tests and skipped lines, a verdict against 500 and 1,000, and the five largest source
files. `--skip` adds patterns of your own to the skipped group (fixtures, vendored code, icons).

Two screens built with the same pattern are one idea. If together they pass 1,000 source lines, split them
anyway: the first PR carries the shared groundwork with the first screen, and the second is a small "same
pattern" PR.

## Plan the stack before writing code

When you plan a story or epic, estimate the source lines. If the work is more than one idea or likely past
about 1,000 source lines, plan it as a stack: a chain of branches, each based on the one below, each opened
as its own PR. Each branch in the stack is a layer; the top branch, which holds every layer, is the tip.

The commands below need git 2.38 or later for `--update-refs`. `<main>` stands for the main branch as you
last fetched it, for example `origin/main`.

Order the layers so each one makes sense alone:

1. **Shared groundwork ships with its first caller.** Never open a PR that adds code nothing in the PR uses.
   A reviewer cannot judge a helper without seeing it used. (A caller that sits behind a switch that is still
   off counts: see rule 3.)
2. **A change visible on a surface that already ships gets its own PR.** If phone users will see a
   difference, that change is reviewed on its own, not buried in the new layout.
3. **The enable switch goes last.** The feature flag or config that turns the work on is the top layer, so
   every earlier layer merges to the main branch as dead code that changes nothing for users. The code in
   those layers is called; it just is not reachable until the switch is on.

### In an Orchestrator Plan step

The Plan step's prompt names no skills, so this part tells it what to add. When the estimate goes past one
idea or about 1,000 source lines, write a `## Slices` checklist in `.harness/state.md` right after
`## Cycles`:

```markdown
## Slices
- [ ] Slice 1 — <idea>: <what a reviewer sees> (~<source lines> source lines)
- [ ] Slice 2 — <idea>: <what a reviewer sees> (~<source lines> source lines)
- [ ] Slice 3 — enable switch: <flag or config> (~<source lines> source lines)
```

End each line in `## Cycles` with the slice it belongs to, for example `(slice 2)`. Show the slices to the
human with the rest of the plan; they approve them together. Nothing ticks the slice boxes today: they record
the agreed split, not progress.

Today the plugin runs one story as one branch and one PR on the base branch, so the slices are a proposal:
they tell the human how the work would split, and they keep the cycles in an order that could split. Opening
each slice as its own PR is not built yet.

## Test at the tip, review per layer

Run the app and the full test suite on the tip, where every layer is present. When you find a bug there:

1. Fix it at the tip.
2. Move the fix to the layer that introduced the bug:

   ```sh
   git commit --fixup=<commit in that layer>
   ```

   Or, if the third-party `git absorb` tool is installed, stage the fix and run `git absorb`: it makes the
   fixup commits and picks the layer for each change itself.

3. Fold the fixups into their layers and move every branch in the stack along with them:

   ```sh
   GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash --update-refs <main>
   ```

   `GIT_SEQUENCE_EDITOR=:` accepts the generated todo list without opening an editor. `--update-refs` moves
   the branch name of every layer to its rewritten commit. If a layer was merged since you last restacked,
   restack first (see "After a layer is squash-merged"), or this replays commits the main branch already has.

A layer is done when:

- the surfaces that already ship behave exactly as before,
- its continuous integration (CI) checks are green on its own branch,
- its code makes sense read alone, without the layers above it.

## Review fixes

While a layer is under review, answer feedback with a **new commit on that layer**. Reviewers can see what
changed since they last looked; a squash-merge repo collapses those commits when it merges.

Then restack the layers above it and push them:

```sh
git checkout <top branch>
git rebase --update-refs <layer branch>
git push --force-with-lease origin <each moved branch>
```

`--force-with-lease` refuses to overwrite a branch someone else pushed to since you last fetched. Never
bypass branch protection or required reviews to land a layer.

## After a layer is squash-merged

A squash-merge combines all of a PR's commits into one new commit on the main branch. The layers above it
still hold the old, separate commits, so git does not see them as merged. Replay everything above the merged
layer onto the main branch, starting from the top branch so every layer in between moves too:

```sh
git fetch origin
git rebase --update-refs --onto <main> <old tip of the merged layer> <top branch>
git push --force-with-lease origin <each moved branch>
```

`<old tip of the merged layer>` is the commit hash (sha) of the merged branch's last commit before the merge.
The PR page shows it, or run `git rev-parse <merged branch>` if your local copy has not changed since. If GitHub did not retarget the next
PR to the main branch, change its base yourself (`gh pr edit <n> --base <main>`).

Merge bottom-up, and merge each layer as soon as it is approved. A short stack is easier to keep current.

## Someone else's PR stacked on yours

- Keep your top branch's name, so their PR's base stays valid.
- Tell the owner before you force-push that branch.
- Give them the command to follow you, with your old top's commit hash (sha):

  ```sh
  git rebase --onto <your new top> <your old top sha> <their branch>
  ```

- Never push to their branch.

## Restructuring a stack

When you move commits between layers, split a layer or merge two, the final code must not change. Before
pushing anything:

```sh
git diff <old tip> <new tip>
```

The output must be empty. If it is not, the restructure changed behaviour: find out why before you push.
Keep the old tip's sha (or a backup branch) until the new stack is pushed.

## PR body

Each layer's PR body has these parts:

```markdown
## Purpose
<the one idea, in one or two sentences, and where it sits in the stack: "2 of 4, based on #123">

## Size
Source: <n> lines (added + deleted). Tests: <n> lines.
<above 1,000 source lines: why this is still one idea>

## How to review
Start with these files; the rest follows from them:
- `<path>` — <what to look at>
- `<path>` — <what to look at>
- `<path>` — <what to look at>

The tests read by name:
- <describe name>
  - <it name>
  - <it name>

## Try it
Tip build (all layers): <link>

## Screenshots
<one per screen this layer changes; leave the section out when it changes none>
```

Name three or four source files under "How to review": the ones that carry the idea. Leave the tests out of
that list; their describe and it names, listed below it, say what they check.
