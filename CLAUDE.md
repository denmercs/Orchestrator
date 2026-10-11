# Orchestrator

In this repo, commit, push and open the PR yourself when the work passes its gates (`npm test`,
`npm run typecheck`). Don't stop to ask. This overrides the global "never commit" rule for this repo only.
Never force-push, and never merge a PR, except by voice as below.

## Merge by voice

When the user says "merge it" in Paseo voice mode, find this session's open PR (`gh pr view`), check
conflicts, CI (`gh pr checks`), review decision and draft state, and read the diff (`gh pr diff`). Speak
at most three sentences: what it does and anything that looks off.

If it has conflicts, a failing or running check, requested changes, or is a draft, say which and stop: don't
offer to merge, and don't merge even if asked to merge anyway. Otherwise end with "Say merge to merge it, or
skip." and wait. Merge only after they say "merge" ("yes" and "confirm" don't count), and only the head you
reviewed: `gh pr merge <n> --merge --match-head-commit <reviewed sha>`. If GitHub refuses, say why. "Skip" or
"no" cancels. Don't delete the branch.

Inside the Orchestrator story loop, the step prompt still decides: if it says the plugin commits, leave it.
