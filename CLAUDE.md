# Orchestrator

In this repo, commit, push and open the PR yourself when the work passes its gates (`npm test`,
`npm run typecheck`). Don't stop to ask. This overrides the global "never commit" rule for this repo only.
Never force-push, and never merge a PR, except by voice as below.

## Merge by voice

When the user says "merge it" in Paseo voice mode, find this session's open PR (`gh pr view`), check
conflicts, CI (`gh pr checks`), review decision and draft state, and read the diff (`gh pr diff`). Speak
at most three sentences: what it does, anything that looks off, and a verdict ("looks good" or "I wouldn't
merge it yet: …"). Then wait. Merge only after they say "confirm", and only the head you reviewed:
`gh pr merge <n> --merge --match-head-commit <reviewed sha>`. "No" cancels. Don't delete the branch.

Inside the Orchestrator story loop, the step prompt still decides: if it says the plugin commits, leave it.
