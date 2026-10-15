# Engineering rules (Claude Code entry point)

Canonical source: this repo's `rules/`. This file is the single
thing `~/.claude/CLAUDE.md` imports — **add or remove rules here, never there.**

`node scripts/link-kit.mjs` reads the `@` lines below and
links those rules into `~/.claude/rules/` and `~/.kiro/steering/` (as `.md`, which
is all Kiro loads). Re-run it after adding or removing a rule.

**Note:** the `globs:` frontmatter in each `.mdc` is a Cursor feature. Claude
Code and Kiro load every rule in every repo regardless. Each rule self-scopes in its
own opening line — honour that, and skip a rule whose stack is not in play.

## Scope

These apply to **every repo**, whoever it is for. They are deliberately
org-neutral: no employer's conventions, no client's code, nothing that should
not cross between one project and another. If a rule ever needs an
org-specific fact to make sense, that fact belongs in that repo's own
`AGENTS.md`, not here.

Where a repo's own convention conflicts: the repo wins on **style**, the rule
wins on **discipline** — tests, gates, scope, security. If a rule is genuinely
wrong for a repo, say so rather than quietly ignoring it.

## Before the first edit in any repo

These rules are stack-shaped, not repo-shaped. They tell you to run the repo's
gate and follow the repo's dialect — neither of which they can name.

So in a repo you have not worked in this session, **read its own instructions
first**: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, or the `scripts` block in
`package.json` / the build file. Claude Code auto-loads only `CLAUDE.md`; a repo
whose conventions live in `AGENTS.md` will not reach you unless you go get it.

Repo facts beat these rules on style. These rules beat the repo on discipline.

## Two layers, deliberately non-overlapping

**Line level — how to write the code in front of you.**

- @~/.claude/rules/typescript-ai-rules.mdc
- @~/.claude/rules/react-patterns.mdc
- @~/.claude/rules/frontend-testing.mdc

**Change level — boundaries, what ships with a change, what "done" means.**

- @~/.claude/rules/frontend-engineering.mdc
- @~/.claude/rules/backend-engineering.mdc
- @~/.claude/rules/opus-review-before-ship.mdc

When something belongs in both, it lives in the line-level rule and the
change-level rule points at it. Nothing is stated twice.

Stack-specific *how* lives in skills, one layer below these rules. Same
relationship: skills cover the line, rules cover the diff.
