# Peer review rubric

Read from [SKILL.md](SKILL.md) Phase 3. Stack-agnostic. Repo-specific conventions and commands come from [PROFILES.md](PROFILES.md).

## Severity ladder

Four levels. Every drafted comment carries exactly one, and the label is part of the posted text so the author can triage at a glance.

| Label | Means | Bar to use it |
|-------|-------|---------------|
| **blocking** | Merging this ships a defect, a security hole, or data loss | You can state inputs/state → wrong result, and point at the code path. No hypotheticals. |
| **should-fix** | Real problem, not a merge blocker — missing test on a risky path, a convention violation the repo documents, a maintainability trap | Named consequence, even if delayed. Cite the convention file when the finding rests on one. |
| **question** | You suspect something but cannot prove it, or intent is unclear | Genuinely open. If you know the answer, it belongs in one of the levels above. |
| **nit** | Naming, ordering, phrasing, style a formatter doesn't enforce | Optional by construction. Author may ignore without replying. |

**Downgrade when uncertain.** A blocking finding that turns out to be wrong costs you the author's trust for every future review. A question that turns out to be a bug costs nothing — the author answers it and fixes it.

## Comment budget

Nit spam is the characteristic failure of machine PR review. Enforce:

- **≤3 nits per PR.** Over that, drop the weakest ones — do not "just mention" them all.
- **Zero nits about anything the repo's formatter owns.** If Prettier, Biome, Scalafmt, or `bsfmt` would rewrite it, CI already owns it. Say nothing.
- **One comment per distinct issue.** The same mistake in eight files is one full comment naming the pattern; the other locations get a short "same as above" pointer, not a rewritten comment. It counts once against the budget.
- **No comment that only restates the diff.** "This adds a new prop" tells the author nothing.
- **No comment already made by a human on the PR.** Read the existing threads first.

If total drafted comments exceed ~15, the honest review is usually "this PR is too large to review well" — say that as a should-fix and cover the highest-risk surface thoroughly instead of every surface thinly.

## Dimensions

Score only what the diff actually touches. Each finding gets `file:line` + failure scenario + suggested fix.

### Correctness

- Behavior change per input case: null/undefined, empty collection, zero, negative, boundary, unicode, very large
- Off-by-one, inverted conditional, wrong operator precedence, `==` vs `===`
- Unhandled rejection, swallowed error, `catch` that logs and continues into a bad state
- Async ordering: race between fetch and unmount, missing await, parallel writes to shared state
- Callers of every changed signature — grep them; unmigrated callers are the most common real defect
- Deleted code: what depended on it

### Security

- Authorization and capability checks on every new entry point, not just authentication
- Input validated and sanitized at the trust boundary, output escaped at the sink
- Injection surfaces: string-built queries, shell interpolation, dynamic imports, template rendering
- Secrets, tokens, internal hostnames, or customer data in source, logs, or error payloads
- New dependency: is it needed, maintained, and does it pull a large transitive tree
- Debug code, verbose logs, or test bypasses reachable in a release build

### Tests

- Does the changed risk surface have a test that **would fail if the change were reverted**? Write down which test and how it fails. This is the question, not "is there a test file".
- Assertions on behavior, not on implementation detail or mock call counts
- No test weakened, skipped, or deleted to make the suite green — check the diff for removed assertions, widened matchers, `skip`/`only`
- Right level of the pyramid: a unit test where a unit test suffices, end-to-end (E2E) only for real user journeys
- New branch coverage for new error and empty paths

### Contracts and compatibility

- Public interface, schema, or API shape changed → are all consumers updated, and is the old shape still accepted where clients may lag?
- Generated artifacts regenerated (types, GraphQL documents, migrations, locale files)
- Persisted data shape changed → migration for existing rows, and behavior for records written by the old code
- Feature-flag or version guard where the repo releases behind flags

### Frontend, when the diff touches user interface

- Loading, empty, error, and offline states for every new data path
- Keyboard reachability, focus order, visible focus, accessible name on interactive elements
- Effect dependency arrays: stale closures, missing cleanup, effects that should be derived state
- Avoidable re-renders from new object/array/function identities in props or context
- Design tokens over hardcoded color, spacing, and typography literals; both light and dark modes
- Localization keys for new user-facing strings

### Maintainability

- Duplication of something already in the codebase — grep before flagging, and name the existing helper
- Boundary discipline: does the logic live in the layer the repo documents for it
- Naming that contradicts the domain language in `AGENTS.md` / `CONTEXT.md`
- Comments on changed lines: are they explaining *why*, or narrating *what* the code already says
- Dead code, commented-out blocks, stray debug statements left in the diff

## Recommendation mapping

| Findings present | Recommend |
|------------------|-----------|
| Any **blocking** | request changes |
| **should-fix** only | comment — say which ones you would want resolved before merge |
| **question** / **nit** only | approve *(recommendation only — the human clicks it)* |
| Nothing material | approve, and state residual risk and what you did not verify |

Never recommend approve while a critical check was skipped on a high-risk change. Say what needs running first.
