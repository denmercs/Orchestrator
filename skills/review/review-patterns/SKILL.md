---
name: review-patterns
description: >
  Mine a team's merged pull-request review history into anonymous, portable
  review principles (what reviewers flag, how they phrase it) and write them to a
  review patterns file in the repo. Scrubs people,
  links, keys and code before analysis; every principle needs 3+ PRs from 2+
  reviewers and must name no person, product or repo. Use when the user says
  review patterns, mine reviews, team review conventions, or write a review
  patterns file. Not for reviewing a PR (use peer-review).
---

# Review patterns (mine the team's review habits)

**Does:** pull merged-PR review comments with `gh`, scrub them, distil recurring themes into stack-agnostic principles, gate them, and — on the human's go — write them to a patterns file in the repo you studied (default `docs/review-patterns.md`), which [`peer-review`](../peer-review/SKILL.md) loads when it reviews that repo.
**Does not:** review a PR ([`peer-review`](../peer-review/SKILL.md)), score or rank individual reviewers, or keep raw comments.

## Hard rules

1. **Nobody is identifiable.** Never output a name, login, email, @mention, ticket key, URL, commit SHA, or verbatim comment. Never report per-reviewer counts, who reviewed whom, or which reviewer raised what. Reviewer ids (`r1`, `r2`) exist only so the gate can count distinct reviewers.
2. **Principles, not product.** Output must make sense to someone who has never seen the source repos. No product, repo, company or vendor names; generalize ("a support widget", "TV and remote-driven screens").
3. **The gate decides, not you.** A principle ships only if `check` passes it. Don't hand-edit evidence to get over the bar; don't relax the thresholds without the human asking.
4. **Scratch stays scratch.** The corpus and chunk files live in `.tmp/review-patterns/` (gitignored) and are deleted at the end.
5. **Nothing is written without an explicit go.** Mined patterns can reflect private work, so they go to the studied repo, never into this kit.

## Phase 1 — Scope

Agree with the human:

- **Repos** (`owner/name`), and any **paths to exclude** inside a monorepo (another product's app folder). Exclusion drops PRs that only touch that path, inline comments on it, and summaries of PRs mostly under it.
- **History depth:** default is everything (`--limit all`). Each comment is tagged *recent* (merged in the last `--recent-months`, default 12) or *older*.
- **Extra terms to strip** (`--term`) — org or product words not in the repo names.

## Phase 2 — Mine

```bash
node .claude/skills/review-patterns/scripts/mine-review-patterns.cjs mine \
  --repo owner/one --repo owner/two --limit all \
  --term orgword --exclude-path apps/other-product/
```

Use `~/.claude/skills/review-patterns/scripts/mine-review-patterns.cjs` when the skill is installed globally. Keeps human reviewer comments only (no bots, no PR-author replies). Writes `.tmp/review-patterns/corpus.json` and prints totals. About 4,000 PRs takes ~8 minutes and stays inside the GitHub GraphQL rate limit.

Spot-check the scrub before reading on: grep the corpus text for `http`, `@`, ticket-key and SHA shapes. Any hit is a scrubber bug — fix `.claude/skills/review-patterns/scripts/lib/review-scrub.cjs` (or the `~/.claude/skills/review-patterns/scripts/lib/review-scrub.cjs` copy) and re-mine; don't read past it.

## Phase 3 — Read and tag

Under ~300 comments: read the corpus yourself. Over that, split it into ~700-comment chunks and hand each to a parallel reader agent with the current principle list (the patterns file, or `candidates.json` from a prior run). Each reader returns:

```json
{ "existing": { "<principle-id>": ["c12", "c40"] },
  "new": [{ "id": "kebab-id", "category": "…", "principle": "…", "evidence": ["c1", "c2", "c3"] }] }
```

Tell readers: tag strictly (generic "LGTM" is not evidence), at most two principles per comment, new themes need 3+ comments, principle text is portable and names nothing.

## Phase 4 — Consolidate

Readers working on separate chunks rediscover the same theme under different ids. Merge them by meaning into one principle each, union the evidence, and write `.tmp/review-patterns/candidates.json`:

```json
{ "principles": [{ "id": "…", "category": "…", "principle": "…", "evidence": ["c…"] }] }
```

Keep principles to one or two sentences: what to look for, and why it matters when that isn't obvious.

## Phase 5 — Gate

```bash
node .claude/skills/review-patterns/scripts/mine-review-patterns.cjs check --candidates .tmp/review-patterns/candidates.json
```

Per principle: PASS/FAIL, PR and reviewer counts, and age (`recent + older`, `recent`, `older only`). FAIL reasons are thin evidence (< 3 PRs or < 2 reviewers) or a leak (name, login, link, key, SHA, repo term, leftover `[someone]` placeholder). A false-positive name hit on a generic word belongs in `NAME_STOPLIST` in the scrubber, not in a reworded principle that dodges it.

Spot-check a few random evidence comments per principle to confirm readers tagged accurately.

## Phase 6 — Human gate, then write

Present in chat:

- Totals (PRs, comments, reviewers, recent share) and what was excluded.
- Passed principles grouped by category, with counts and age.
- What failed and why.
- Judgment calls: *older only* principles, thin evidence (e.g. one comment pasted into three PRs), and any principle that contradicts existing `peer-review` rules.

Ask the human which file to write; the default is `docs/review-patterns.md` in the repo being studied. On a go, write the passed principles there with a short intro and a *Last mined* line. Format: `- <principle> _(N PRs · M reviewers[ · older only | · recent])_`. If a principle contradicts a rule in `peer-review`, raise it with the human; don't silently leave both.

## Phase 7 — Clean up

```bash
rm -rf .tmp/review-patterns
```

Then report what changed in the patterns file and stage it — never commit.
