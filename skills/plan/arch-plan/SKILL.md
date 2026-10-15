---
name: arch-plan
description: >
  Project or plugin architecture direction. Markdown is the plan source of truth;
  HTML is derived for humans with the plan-html render script (current vs target,
  decisions, stages with Jira epic keys). Refreshes epic status into the Markdown
  one way from Jira when keys exist, then re-renders. Use for structural direction
  before delivery. Does not implement code or replace story Plan TDD grilling.
---

# Architecture plan

Set **project or plugin architecture direction** as a living **Markdown** plan with a derived **HTML** briefing for humans.

**Prose:** apply the `anti-slop` skill to plan copy and chat. Expand abbreviations on first use; no hype in "At a glance".

## Companion extra

Load `plan-html` with this skill; it holds the render scripts.

Run them as `.claude/skills/plan-html/scripts/<file>`. If that path is missing, use `~/.claude/skills/plan-html/scripts/<file>`.

- Scaffold: `node .claude/skills/plan-html/scripts/init-plan-html.cjs [repo-root] --kind arch --slug <slug>` (fallback `~/.claude/skills/plan-html/scripts/init-plan-html.cjs`)
- Render: `node .claude/skills/plan-html/scripts/render-plan-html.cjs [repo-root] --kind arch --slug <slug> --validate` (fallback `~/.claude/skills/plan-html/scripts/render-plan-html.cjs`)
- Validate: `node .claude/skills/plan-html/scripts/validate-plan-html.cjs [repo-root] --kind arch --file <html>` (fallback `~/.claude/skills/plan-html/scripts/validate-plan-html.cjs`)

## Source of truth

The living Markdown (`architecture-plan.md`) is **the** source of truth: target shape, diagrams (Mermaid fences), open and resolved decisions, phased rollout, epic and story keys, and **status as shown** after refresh.

**Derived view:** render with `--kind arch` so humans open `architecture-plan.html` in a browser. **Do not hand-edit** the HTML. Follow [HTML-REPORT.md](HTML-REPORT.md) for the section contract; agents edit Markdown sections (`## phase`, `## current`, and so on).

| Layer | Role |
|-------|------|
| **Markdown** | Plan source of truth. Read and decide from here |
| **HTML** | Human browser view, derived only |
| **Jira epics and stories** | Workflow; **keys join** stages to tickets; status **feeds into** the Markdown on refresh |
| **Architecture decision records (ADRs) and `CONTEXT.md`** | Narrow permanence for load-bearing *why* and glossary names |

**One way only:** Jira to Markdown on refresh, then re-render the HTML. Never push workflow status from this skill back to Jira. Create or link epic keys when publishing stages; do not transition issues here.

If the Markdown and Jira disagree after a refresh, refresh again or fix the key mapping. Do not invent a second plan in chat.

Follow-up answers **update that same Markdown**, then re-render the HTML before the next question. Do not spawn timestamped copies per answer.

## Boundaries

| Use this | Use something else |
|----------|-------------------|
| Plugin or project target shape, seams, phased migration | One story's behaviors: the story Plan step |
| Living plan source of truth (HTML) with epic-keyed stages | Multi-epic product scope: `major-feature-roadmap` |
| Open decisions and stages toward a target | Deepening friction only: `improve-codebase-architecture` (reuse its exploring mindset inside this flow) |
| Structural direction before delivery | UI flows: `ui-ux-planner` |
| Module shape and seams | Security posture or the per-PR security gate: their own steps |

**Non-goals:** no production code, no RED tests, no React or textbook encyclopedia, no two-way Jira sync, no second competing plan doc. Do not load stack novels by default.

## Not the loop

Orchestrator owns initiative architecture sessions (`architecture.md` per phase). This skill is the Markdown and HTML extra for planning architecture on its own. Skip it when the structure is already agreed.

## Vocabulary

Use these terms exactly: **module**, **interface**, **implementation**, **depth**, **seam**, **adapter**, **leverage**, **locality**. Prefer `CONTEXT.md` names for domain concepts.

## On every run

1. **Locate** the living Markdown (resolve order below).
2. **If it exists and any stage has an epic key**, run **Refresh status** into the Markdown, re-render the HTML, and tell the user to refresh the browser.
3. **Then** continue as the user needs: draft (if missing), decision loop, lock and publish, or handoff.
4. If the Markdown exists but has **no** epic keys yet, skip Jira and resume planning.
5. If there is no Markdown, explore and draft it with the init script above (no Jira required).

### Refresh status (Jira to Markdown only)

This is a prose step driven by the Atlassian MCP. No script does it. When stages list epic or story keys (for example `PROJ-245`, `story: PROJ-271`):

1. Read the consumer's `docs/agents/issue-tracker.md` (project key, epic type) when present.
2. With the **Atlassian MCP**, read each tool schema before calling. Fetch each keyed issue, preferring the **story** when set, else the epic.
3. For each stage, update the **Jira status** (and the title if useful) in the Markdown stage lines. Show the **raw Jira status name**, plus blocked-by notes when present.
4. Set the frontmatter `jira_refreshed` to today. Update the **phase** and **finish-line** sections when they exist.
5. Re-render the HTML with the render script.
6. **Do not** transition, comment on, or edit Jira fields for status.
7. If the MCP is unavailable, note the keys that could not refresh, leave the prior badges, and continue planning.

Compare at **epic** level for portfolio or home; at **story** level for stage progress when stories exist.

**Prose in chat:** full sentences and scannable lists. Resume brief mode after planning if the session uses it.

## Living plan paths

**Resolve order:**

1. A path from the consumer's `docs/agents/domain.md` when it documents the architecture source of truth
2. Initiative pack: `.harness/initiatives/<slug>/architecture-plan.md` (`--slug`, or the only pack under `initiatives/`)
3. Single file: `.harness/architecture-plan.md`

Create the pack with the init script (or mkdir and write the Markdown). One Markdown file per train; **rewrite in place**, no timestamped copies. The HTML is always derived.

When the user says **"lock this"** or approves, optionally copy the rendered HTML to `docs/architecture/` (or the path named in `docs/agents/domain.md`). **Markdown remains the plan source of truth**; ADRs still record the irreversible *why*.

Open after render: `open <path.html>` (macOS), `xdg-open` (Linux), `start` (Windows).

Section contract: [HTML-REPORT.md](HTML-REPORT.md). Stages and epic keys: [STAGES.md](STAGES.md).

## Repo inputs

Read when present:

1. The consumer's `AGENTS.md`, `docs/agents/domain.md`, `docs/agents/issue-tracker.md`
2. `CONTEXT.md`, `CONTEXT-MAP.md`, `docs/adr/`
3. Entrypoints and package layout (plugin bootstrap, `src/`, public APIs)
4. The parent initiative or capability brief from chat
5. An existing `architecture-plan.md` (check `domain.md` and the pack first)

Load stack skills **only when** the consumer is clearly that stack and the question needs them.

When the draft must confront real friction in existing modules, use the explore mindset from `improve-codebase-architecture` (deletion test, shallow vs deep) and fold findings into **Current shape** and **Open decisions**.

## Workflow

### 1. Frame direction

- **Primary job** of the architecture (one sentence)
- **Scope**: whole plugin or project vs one area
- **Non-goals**
- **Constraints**: platform, public API stability, existing ADRs

### 2. Draft or update the living Markdown

Build sections per [HTML-REPORT.md](HTML-REPORT.md). **Required**:

1. Frontmatter (`product`, `status`, `updated`, `task`)
2. **`## phase`** (once any tracker join exists)
3. **`## finish-line`** once stories are keyed
4. **`## locks`** when locks exist
5. **`## current` and `## target`**, as Mermaid fences
6. **`## decisions`**: open expanded, resolved compact (`### d0` articles)
7. **`## stages`**, per [STAGES.md](STAGES.md), with `epic:` and `story:` meta lines
8. **`## nongoals`**

Then render with `--kind arch --validate`.

Keep prose sparse. Diagrams and cards carry understanding; the finish line carries **what to pick up next**.

### 3. Decision loop

Until the user locks or pauses:

1. Point at the highest-impact **open** decision.
2. Ask one focused question with a recommended option.
3. On answer, rewrite the Markdown: resolve the decision, update target, stages and diagrams, refresh locks and phase when needed, then re-render the HTML.
4. Repeat.

Material means it changes the target shape, a seam, a stage, a key, or a named decision.

### 4. Publish tracker keys (optional)

When stages are stable enough to track:

**Dual track:** when a second epic owns a capability train, document it as **Epic B** under `#finish-line` / `#epic-b`. Do not duplicate it as a second S0 to S5 stage list. Stages (`#stages`) stay the platform and deepening checklist on the home epic.

1. Split the stages into stories, **folding into existing epics** when possible (retitle the home epic and add stories per stage; a secondary epic for the B train). Create one epic per stage only when no home epic fits.
2. Write the keys into the Markdown (`epic:` and `story:` lines, phase mapping, finish-line rows).
3. Do not invent status. The next refresh fills it.

### 5. Promote and hand off

When direction is **agreed**:

| Artifact | When |
|----------|------|
| `CONTEXT.md` terms | New module or concept names |
| Architecture decision record (ADR) | Load-bearing *why* |
| Split into stories | Publish stages as epics and stories if keys are missing |
| The story Plan step | Per stage or first vertical slice, for behavior and TDD |

**Handoff:** split into stories (if there are no keys), or run the story Plan step for the first stage. Do not start implementing until a behavior plan exists.
