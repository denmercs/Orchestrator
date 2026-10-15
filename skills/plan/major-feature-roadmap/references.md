# Planning foundations

This skill combines practices from product planning and agile delivery. Use them as **lenses**, not rigid ceremony.

## Core workflow mapping

| Practice | What we borrow | Where in this skill |
|----------|----------------|---------------------|
| **User story mapping** (Jeff Patton) | Backbone of user activities + horizontal release slices | Required story map, release plan |
| **Release planning** (Mike Cohn) | Order capabilities into incremental releases; avoid big-bang | v1 / v1.1 slices, MoSCoW per slice |
| **Feature-driven development (FDD)** | Thin, named features under each capability | Feature lists per capability |
| **Initiative → epic → story hierarchy** | Altitude ladder for large product areas | Capability epics, v1 stories only in pass 1 |

## Recommended reading

Read when you want depth beyond what the agent produces in one session:

### Jeff Patton — *User Story Mapping*

- **Use for:** Visualizing the user journey (backbone) and cutting **vertical slices** that ship value incrementally.
- **In this skill:** Story map section is Patton-style — activities left-to-right, releases as horizontal cuts.

### Mike Cohn — *Agile Estimating and Planning*

- **Use for:** Breaking large work into **ordered releases**, managing risk, and avoiding commitment to a full backlog upfront.
- **In this skill:** Release train (v1, v1.1), capability ordering, deferring future-slice stories.

### Feature lists (FDD-style)

- **Use for:** Named, prioritizable units smaller than epics but larger than stories — easier to estimate and slice than premature user stories.
- **In this skill:** Feature tables under each capability; stories only for the **current shippable slice**.

## What this skill deliberately does not cover

| Topic | Where it lives |
|-------|----------------|
| Full story backlog for every slice | Re-run this skill when a new slice is scheduled |
| RED tests and implementation seams | the story Plan step, `grill-tdd` |
| PRD for one deliverable | `to-prd` |
| ADR writing | `grill-with-docs` |
| Tracer-bullet vertical slice issues | `to-issues` |
| WSJF / formal estimation | Only when user explicitly requests |

## Prioritization cheat sheet

| Method | When |
|--------|------|
| **MoSCoW** per slice | Default — Must/Should/Could/Won't per release |
| **Risk tags** | Always — `schema`, `perf`, `compat`, `migration`, `security` |
| **Dependency order** | Capabilities and stories with `Blocks` links |
| **WSJF** | User asks for cost-of-delay style ranking |

## Cross-cutting capabilities

Some concerns span multiple capabilities. Handle them explicitly — do not hide inside unrelated epics:

- **Performance & scalability**
- **Permissions & roles**
- **Compatibility & migration**
- **Security & data handling**

Either:

1. Name them as **their own capabilities** (own epic), or
2. Tag every affected feature with cross-cutting labels and note the **owning** capability.

## Revision vs deep dive

| Situation | Action |
|-----------|--------|
| Adjust slices, MoSCoW, or feature lists | Update initiative spec + Jira epic descriptions |
| One capability needs 10+ pages of design | Spin `spec-*-epic-<slug>.md` in the product repo; link from initiative |
| New slice enters delivery | Expand **that slice** to stories; re-run ambiguity gate for slice |
| Terminology conflict | `grill-with-docs` |
