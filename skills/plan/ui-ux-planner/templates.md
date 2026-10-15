# UX plan templates

Tracker- and product-neutral. **Source of truth is the living Markdown plan** — see [HTML-REPORT.md](HTML-REPORT.md) and `.harness/initiatives/<slug>/ux-plan.md`.

Use this file for **optional thin markdown export** (tracker paste) and parent/story body snippets. Do **not** maintain a full second contract in markdown that can drift from the plan.

## Thin markdown export (optional)

Only when the user wants a pasteable file or tracker attachment. Keep it short; deep content stays in the plan.

```markdown
# UX plan — <short title>

**Status:** draft | agreed  
**Slug:** <slug>  
**Source of truth:** `.harness/initiatives/<slug>/ux-plan.md`  
**Related:** <story/epic key or title — optional>

## Primary job

<one sentence>

## Journeys (seeds for the story Plan step)

### J1 — <name>
- **expectation:** step 1 > step 2 > outcome

### J2 — …
- **expectation:** …

## Surfaces (summary)

| ID | Surface | Primary action |
|----|---------|----------------|
| S1 | … | … |

## Open questions (blocking the story Plan step)

- …

## Handoff

**Next:** the story Plan step. Seed Behavior & Test Contracts from the journeys in the plan.
```

Default export path: **`docs/ux/ux-<slug>.md`** (create `docs/ux/` if needed).

## Capability / parent overview (optional paste)

Use when enriching a larger parent item (capability, epic, initiative section):

```markdown
## UX scope

- **Source of truth:** `.harness/initiatives/<slug>/ux-plan.md`
- **Jobs:** …
- **Journeys:** J1 …; J2 …
- **Principles for this area:** shortest path; one primary action; …

## Out of UX scope

- …

## Open UX decisions

- …
```

## Story body (optional paste)

```markdown
## UX

**plan source of truth:** `.harness/initiatives/<slug>/ux-plan.md` (status: agreed | draft)  
**Export (optional):** `docs/ux/ux-<slug>.md`

### Flow slice
- **expectation:** step > step > outcome

### Surfaces
- …

### States
- Empty: …
- Error: …
- Success: …

### Acceptance (UX)
- [ ] Happy path completes in ≤ N intentional steps (per plan)
- [ ] Primary action is obvious and named accessibly
- [ ] Empty / error / success states behave as listed
```
