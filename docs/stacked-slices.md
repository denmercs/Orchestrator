# Follow-up: open each slice as a stacked PR

Not built. Today one story is one branch and one PR on its base: `openStoryPr` in `server/story-git.ts`
pushes the story branch and runs `gh pr create --base <base>`. The `stacked-prs` skill (`skills/plan/stacked-prs/`,
a default Plan extra) already has Plan write a `## Slices` checklist after `## Cycles` when the work is more
than one idea or about 1,000 source lines, and each cycle names its slice. The slices are a proposal the
human approves with the plan; nothing acts on them yet.

## What the plugin would do

1. **Read the slices.** Parse `## Slices` from `.harness/state.md` the way `## Cycles` is parsed, and the
   `(slice N)` tag on each cycle line. No `## Slices` section keeps today's single PR.
2. **One branch per slice.** Slice 1 branches from the story's base; slice N branches from slice N−1's
   branch. Name them `<story branch>-<N>` (or similar) so the story branch name stays the top of the stack.
3. **Commit each cycle on its slice's branch.** Cycles run in slice order. When the last cycle of a slice is
   committed, the next cycle starts on a new branch from that tip.
4. **Gate per slice.** Run the repo's test suite and type check on each slice branch, not only the tip; a
   slice that fails alone is a broken layer even when the tip is green.
5. **Review at the tip, fix per layer.** Review runs on the top branch. Each fix is committed with
   `git commit --fixup=<commit in its slice>`, then
   `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash --update-refs <base>` folds it in and moves every slice
   branch without opening an editor.
6. **Open one PR per slice.** Slice 1's PR targets the base; slice N's targets slice N−1's branch. The body
   comes from the skill's template, one per slice, and says "N of M, based on #<previous PR>".
7. **After a slice is squash-merged**, rebase the slices above it onto the base, starting from the top
   branch so every slice branch moves: `git rebase --update-refs --onto <base> <old slice tip> <top branch>`.
   Push with `--force-with-lease`, and retarget the next PR to the base if GitHub did not. CI watch and
   Fix CI then follow the next open PR.

## Open questions

- Does the Done phase wait for every slice's merge, or close the Jira story when the top slice merges?
- Where do per-slice PR numbers live: `.harness/ci.json` as a list, or the story's frontmatter?
- Should Plan's estimate be checked against `count-lines.mjs` after Implement, and the human warned when a
  slice lands far over its estimate?
