# Migration stages (architecture plan)

Fixed checklist for moving from **current** to **target** shape. Put these in the living plan's `## stages` section.

**Tracker join:** prefer one **stage-home epic** (the same `epic:` on S0 to S5) plus **stories** per stage (`story:`). Fold into existing epics when they already own the work. Do not spawn six new stage epics by default. On refresh, read status **from** those keys **into** the Markdown (one way).

Adapt titles to the domain; keep the **order and intent**. Skip a stage only when it does not apply, and note the skip in the plan.

| ID | Intent | Acceptance (one line) | Typical join |
|----|--------|------------------------|--------------|
| **S0** | Name the deep module(s) in glossary language | Term(s) in `CONTEXT.md` (or the plan until promoted) | home epic |
| **S1** | Define the interface; tests at the seam | Interface is the test surface; RED contracts for the story Plan step | story under home epic |
| **S2** | Move logic behind the seam | Implementation in the deep module; callers use the interface | story |
| **S3** | Second adapter if justified | Two adapters means a real seam; otherwise skip with reason | story or skip |
| **S4** | Migrate remaining callers | No leakage across the old shallow path | story |
| **S5** | Delete pass-through and obsolete shallow tests | Deletion test passes; locality restored; ADR or `CONTEXT.md` if needed | story |

**Dual-track rule:** Epic A is the stage or platform spine (S0 to S5 cards in `#stages`). Epic B (optional) is a secondary capability train under its own epic, ordered in `#finish-line` / `#epic-b`, not a second S0 to S5 list.

## Epic and story join rules

- **Default:** update or retitle an existing epic as the stage home; publish **stories** for S1 to S5 (and S0 if needed).
- **Alternate:** one epic per stage only when no suitable home epic exists.
- Secondary tracks use a **second epic** and a story table (violet). Say so in Phase, finish-line, and the Stages intro.
- Empty key means no Jira refresh for that row.
- Never push plan badges back as Jira transitions from this skill.

## Rules

- Stages are **vertical deepening or migration steps**, not a vague cleanup backlog.
- Prefer one deep module cluster per stage train; split into a second train if unrelated.
- Stages (with epic and story keys) become stories, then the story Plan step runs per slice.
- **S1** may hand off to the story Plan step for Behavior and Test Contracts before implementation; that is expected.
