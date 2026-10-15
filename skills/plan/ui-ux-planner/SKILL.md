---
name: ui-ux-planner
description: >
  UI/UX planning for product surfaces. Markdown is the plan source of truth; HTML
  is derived with the plan-html render script (journeys, screen inventory, states,
  decisions). Drafts or rewrites the same Markdown, then re-renders. Use when
  designing or redesigning screens or flows, planning UI-heavy stories, or when the
  user asks for senior UX planning before story Plan. Does not write production UI
  code or replace TDD grilling.
---

# UI/UX planner

Plan **product UX** (flows and surfaces) as living **Markdown** with a derived HTML briefing before delivery planning.

The Markdown is the **source of truth**. The story Plan step should seed journeys from it. Do not skip straight to implementation on UI-heavy work.

**Prose:** apply the `anti-slop` skill to plan copy and chat. Expand abbreviations on first use (information architecture (IA), architecture decision record (ADR), accessibility); no brochure voice.

## Companion extra

Load `plan-html` with this skill; it holds the render scripts.

Run them as `.claude/skills/plan-html/scripts/<file>`. If that path is missing, use `~/.claude/skills/plan-html/scripts/<file>`.

- Scaffold: `node .claude/skills/plan-html/scripts/init-plan-html.cjs [repo-root] --kind ux --slug <slug>` (fallback `~/.claude/skills/plan-html/scripts/init-plan-html.cjs`)
- Render: `node .claude/skills/plan-html/scripts/render-plan-html.cjs [repo-root] --kind ux --slug <slug> --validate` (fallback `~/.claude/skills/plan-html/scripts/render-plan-html.cjs`)
- Validate: `node .claude/skills/plan-html/scripts/validate-plan-html.cjs [repo-root] --kind ux --file <html>` (fallback `~/.claude/skills/plan-html/scripts/validate-plan-html.cjs`)

## Source of truth

The living Markdown (`ux-plan.md`) is **the** source of truth for this UX plan: primary job, journeys, surfaces, states, design decisions, accessibility, and open questions.

**Derived view:** render with `--kind ux` to get `ux-plan.html` for humans. **Do not hand-edit** the HTML. Follow [HTML-REPORT.md](HTML-REPORT.md) for the section contract.

| Layer | Role |
|-------|------|
| **Markdown** | Plan source of truth. Read and decide from here |
| **HTML** | Human browser view, derived only |
| Optional `docs/ux/ux-<slug>.md` | Thin paste or export for a tracker, not a competing source of truth |

Follow-up answers **update that same Markdown**, then re-render before the next question. Do not spawn timestamped copies per answer.

## When to use

| Use this | Skip or use something else |
|----------|---------------------------|
| New or redesigned screens, wizards, admin UX, empty and error states | Pure backend with no UI: go to the story Plan step |
| Flow efficiency ("too many steps", unclear primary action) | Multi-epic initiative first: `major-feature-roadmap`, then this for UI-heavy capabilities |
| Design decisions that should stick through TDD | Pixel polish while implementing: keep decisions here, polish later |
| Critique of an existing flow before rewriting | Code review of React performance: `frontend-react-best-practices` |
| Living UX source of truth before the story Plan step | Structure and modules: `arch-plan` |

**Non-goals:** no production UI code, no RED tests, no tracker publish required, no replacing grill-me or grill-tdd, no Jira status refresh.

## Not the loop

Orchestrator owns story Plan then Implement. This skill is the UX extra: agree journeys and surfaces, then Plan maps them to **name** and **expectation** contracts.

If a UX plan already exists for this story and the user confirms it is current, do not re-plan.

## Interaction model

1. **Explore**: the story or epic brief in chat, repo UI patterns, `CONTEXT.md` and design tokens if present.
2. **Draft** the living Markdown. Synthesize first; do not start with a 40-question interview.
3. **Targeted Q&A**: one open decision at a time with a recommended answer (flows, density, progressive disclosure).
4. **Persist**: rewrite the same Markdown, re-render, optionally write a thin export, and summarize for handoff.

**Prose:** full sentences and scannable tables. Resume brief mode after planning if the session uses it.

Foundations and decision rules: [foundations.md](foundations.md). Section contract: [HTML-REPORT.md](HTML-REPORT.md). Optional paste shapes: [templates.md](templates.md).

## Living plan path

**Resolve order:**

1. A path from the consumer's `docs/agents/domain.md` when it documents the UX source of truth
2. Initiative pack: `.harness/initiatives/<slug>/ux-plan.md` (`--slug`, or the only pack under `initiatives/`)
3. Single file: `.harness/ux-plan.md`

Do not use a flat `.harness/ux-<slug>.md` for new plans. Put multi-train UX inside `initiatives/<slug>/ux-plan.md`.

Create the pack with the init script. One file per train; **rewrite in place**, no timestamped copies.

When the user says **"lock this"** or approves, optionally write a **thin** Markdown export to `docs/ux/ux-<slug>.md` for tracker paste. The plan stays the source of truth. Do not maintain a full duplicate contract in the export.

Open after render: `open <path>` (macOS), `xdg-open` (Linux), `start` (Windows).

## Repo inputs

Read when present:

1. The consumer's `AGENTS.md` and design-system notes
2. `CONTEXT.md`, `docs/adr/`
3. Existing UI in the same product area (patterns to match; Jakob's Law)
4. The parent story or capability brief from chat (keys optional, tracker-agnostic)
5. An existing `ux-plan.md` (check `domain.md` and the pack first)
6. Legacy `docs/ux/ux-*.md`: migrate the content into the plan if the plan is missing and the export is the only artifact

## Workflow

### 1. Frame the job

Capture in the plan's `## job` section:

- **Primary job**: one sentence, the user or caller outcome
- **Actors**: who uses this
- **Success**: how we know the flow worked
- **Non-goals**: flows and screens out of scope
- **Constraints**: platform, accessibility bar, existing components, brand and density

### 2. Map efficient flows

For each priority journey (`## journeys`):

1. List steps as `step > step > outcome` (the same shape later used as the test **expectation**).
2. **Cut steps**: merge, default, or progressively disclose until the happy path is minimal.
3. Add **one** primary failure or recovery path (validation, empty, permission), not every edge.
4. Apply [foundations.md](foundations.md): Hick's Law, Fitts's Law, progressive disclosure, feedback.

### 3. Inventory surfaces and states

`## surfaces` and `## states`: surface, purpose, primary action, then empty, loading, error and success.

Prefer **one primary action** per surface. Split screens that compete for two jobs.

### 4. Decide (and record)

Irreversible or high-conflict choices go in `## decisions` (problem, options, choice, why). Offer an ADR only when the consumer already uses ADRs for UX or IA and the choice is hard to reverse.

Material follow-ups: rewrite the **same** Markdown before the next question.

### 5. Handoff checklist

Before closing:

- [ ] Happy path step count is explicit and justified
- [ ] Primary action is obvious on each surface
- [ ] Empty, error and success states are named
- [ ] Accessibility expectations are listed (labels, keyboard, contrast)
- [ ] Open questions are tagged as blocking the story Plan step, or deferred
- [ ] Plan Markdown written or updated, HTML rendered and opened for the user; agreed (or explicitly draft)
- [ ] Next action: the story Plan step, with the plan path referenced

## Tracker-agnostic enrichment (optional)

If the user wants parent, epic or story text updated, use the **Capability overview** and **Story body** sections of [templates.md](templates.md). They are paste-ready by default and point at the plan path. Only call a tracker MCP when the **consumer** already uses one and the user asks to publish. Never hard-code a vendor workflow in this skill.

## Anti-patterns

- Horizontal tickets: "design all screens" then "build all screens"
- Skipping flow work and jumping to colors and shadows
- Inventing a new pattern when the product already has one
- Specifying implementation (CSS grid, component library internals) unless constraints require it
- Dual source of truth: a full export and the plan saying different things
- Replacing the story Plan step. This skill stops at the UX plan

## Done definition

Stop when:

1. The living plan is written and agreed (or accepted as draft with open questions listed), and
2. The handoff says to run the story Plan step next (unless the user scopes design-only discovery).
