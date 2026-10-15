# Jira description templates

Mirror the initiative spec into Jira. Epic and story descriptions must be **self-contained** — a reader should not need the repo open to understand scope, though linking the spec path is required.

## Epic description (capability spec)

Use as the `description` field for `jira_create_issue` (`issue_type: Epic`).

```markdown
## Capability

[One-line value statement]

**Initiative:** [Initiative name]
**Release slice:** v1 | v1.1 | ...
**Risk tags:** schema, perf, compat, migration, security

## Spec source

`[initiative spec path]` — section "[Capability name]"

## UX scope

- Screens / flows / states
- ...

## Tech constraints

- ...
- ...

## Integrations

- REST / hooks / editor / ...
- ...

## Features

| Feature | Priority (slice) | Notes |
|---------|------------------|-------|
| ... | Must | |

## Out of scope

- ...

## Open ambiguities

Capability-level unknowns still open or deferred (honest overview — not story implementation detail):

| Question | Blocks | Status | Notes |
|----------|--------|--------|-------|
| ... | v1.1+ | deferred | ... |

## Dependencies

- **Blocks:** PROJ-xxx or —
- **Blocked by:** PROJ-xxx or —

## Acceptance (capability complete)

High-level criteria for considering this epic done across its stories:

- [ ] ...
```

## Story description (implementation spec)

Use as the `description` field for v1 `Story` issues. Link to epic via `jira_link_to_epic` or `additional_fields` per `issue-tracker.md`.

```markdown
## Parent epic

PROJ-xxx — [Capability name]

## User story

As a [actor], I want [goal], so that [benefit].

## Spec source

`[path/to/initiative-spec.md]` — v1 story "[Story title]"

## What to build

End-to-end behavior for this story — demoable on its own within the v1 slice.

## Acceptance criteria

- [ ] ...
- [ ] ...
- [ ] ...

## Implementation spec

Ground in **this repo's** stack (read from codebase and the repo's docs):

### Data & API

- Endpoints, stores, schema changes, migrations
- ...

### UI / UX

- Surfaces (admin, block editor, front-end)
- States: empty, loading, error, success
- ...

### Integration & compatibility

- Hooks, filters, plugin boundaries
- ...

### Verification

- Unit / integration / E2E expectations for this story
- ...

## Resolved assumptions

Decisions from the ambiguity register that lock this story's implementation spec:

- ...

## Dependencies

- **Blocked by:** PROJ-xxx or **None — can start immediately**

## Out of scope

- ...
```

## Initiative parent epic (optional)

When the team tracks the whole initiative as one Jira epic:

```markdown
## Initiative

[Outcome one-liner]

**Themes:** performance, authoring UX, ...

## Spec source

`[path/to/initiative-spec.md]`

## Capabilities (child epics)

| Capability | Epic | Slice |
|------------|------|-------|
| ... | PROJ-xxx | v1 |

## Story map

[Embed or link to Mermaid backbone + slices from initiative spec]

## Release train

| Slice | Focus |
|-------|-------|
| v1 | ... |
| v1.1 | ... |

## Success metrics

- ...
```

## MCP publish order

1. Parent initiative epic (optional)
2. Capability epics (dependency order) — **overview specs in descriptions**
3. **Strict v1 gate** — confirm zero open `Blocks: v1` ambiguities initiative-wide
4. v1 stories (dependency order) — **implementation specs in descriptions**
5. `jira_create_issue_link` for `Blocks` relationships
6. Update initiative spec **Jira index** with all keys

Optional: `jira_batch_create_issues` with `validate_only: true` to dry-run before create.
