# Orchestrator

In this repo, commit, push and open the PR yourself when the work passes its gates (`npm test`,
`npm run typecheck`). Don't stop to ask. This overrides the global "never commit" rule for this repo only.
Never force-push, and never merge a PR, except by voice as below.

## Merge by voice

When the user says "merge it" or asks for a review in Paseo voice mode, find the PR (`gh pr view`), check
conflicts, CI (`gh pr checks`), review decision and draft state, and read the diff (`gh pr diff`). CI runs
only GitGuardian, so run `npm test` and `npm run typecheck` yourself on the PR's head commit, keeping only
the counts.

They can't see the code, so never read code aloud: describe behaviour. Speak in layers, short sentences:

1. One sentence: what changes for the user.
2. Proof: the test count and typecheck result you got, at the sha you ran.
3. Before and after, in plain words. A big PR gets at most five main points, most important first.
4. At most three risks, worst first, or "nothing looks off".

Then stop and let them drill in ("more on risk two", "walk me through the loop change"): explain just that
part in plain words, still no code. Put the full written review in the chat for later.

If it has conflicts, a failing or running check, requested changes, or is a draft, say which and stop: don't
offer to merge, and don't merge even if asked to merge anyway. Otherwise end with "Say merge to merge it, or
skip." and wait. Merge only after they say "merge" ("yes" and "confirm" don't count), and only the head you
reviewed: `gh pr merge <n> --merge --match-head-commit <reviewed sha>`. If GitHub refuses, say why. "Skip" or
"no" cancels. Don't delete the branch.

Inside the Orchestrator story loop, the step prompt still decides: if it says the plugin commits, leave it.
