# UX plan — living plan (MD → HTML)

Self-contained briefing for **product UX** (flows + surfaces). The Markdown is the **plan source of truth**; the HTML is derived with the render script (`.claude/skills/plan-html/scripts/render-plan-html.cjs`, fallback `~/.claude/skills/plan-html/scripts/render-plan-html.cjs`). Same craft as the architecture plan's `HTML-REPORT.md`: sticky nav, **dark** zinc chrome + emerald/sky/amber, Mermaid for journeys when helpful, sparse prose.

**Not** delivery/TDD planning — that remains the story Plan step. This plan answers *how the user moves through surfaces*; the story Plan step turns journeys into Behavior & Test Contracts.

**Lifecycle:** rewrite the **same** `.md` after every material follow-up, then re-render. Do not timestamp a new file per answer. Rejected explorations may live in a sibling archive file linked from the nav.

## Why Markdown + derived HTML

| Format | Use |
|--------|-----|
| **`ux-plan.md`** (`.harness/initiatives/<slug>/` or `.harness/`) | plan source of truth — journeys, surfaces, states, decisions, open questions |
| **`ux-plan.html`** | Human browser view — derived with the render script; do not hand-edit |
| Optional `docs/ux/ux-<slug>.md` | Thin paste/export for tracker — **not** a second source of truth |

## Scaffold

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>UX plan — {{short title}}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script type="module">
      import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
      mermaid.initialize({ startOnLoad: true, theme: "dark", securityLevel: "loose" });
    </script>
    <style>
      html { scroll-behavior: smooth; }
      section[id] { scroll-margin-top: 5rem; }
      a { color: #93c5fd; }
    </style>
  </head>
  <body class="bg-zinc-950 text-zinc-100 font-sans">
    <nav class="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur px-4 py-2">
      <!-- Phase · Job · Locks · Journeys · Surfaces · States · Decisions · A11y · Open · Handoff -->
    </nav>
    <main class="max-w-5xl mx-auto px-6 py-10 space-y-14">
      <header>…</header>
      <section id="phase">…</section>          <!-- once story/epic keys exist -->
      <section id="job">…</section>
      <section id="locks">…</section>
      <section id="journeys">…</section>
      <section id="surfaces">…</section>
      <section id="states">…</section>
      <section id="decisions">…</section>
      <section id="a11y">…</section>
      <section id="open">…</section>
      <section id="nongoals">…</section>
      <section id="handoff">…</section>
      <footer>…</footer>
    </main>
  </body>
</html>
```

Only scripts: Tailwind CDN + Mermaid ESM. Otherwise static.

## Sticky nav

Compact top bar (`text-xs`): product/slug label + in-page anchors. Emphasize **Journeys** (`#journeys`) and **Handoff** (`#handoff`) — those seed the story Plan step. Include **Phase** (`#phase`) when that section exists. Keep nav scannable — no paragraphs.

## Header

- Eyebrow: `{{repo or plugin}} · {{slug}} · {{story/epic key optional}}`
- `h1` serif: **UX plan**
- Meta row: **Status** (`draft` | `agreed`), **Updated**, optional related key
- **Primary job** — one strong sentence (user/caller outcome)
- Source-of-truth one-liner: living HTML; journeys seed the story Plan step Behavior & Test Contracts

## Phase (`#phase`) — required once story/epic keys exist

Same pattern as arch-plan / security-plan: where this UX work sits in the delivery loop vs tracker.

1. **Delivery loop** — ordered list: optional architecture plan, UX plan (current), story Plan, implement. Grey completed steps; bold the current one.
2. **Jira posture** — epic/story homes for this UX plan (white card).
3. **Mapping table** — journey or surface → story/epic key → status (one row per join).
4. **Read this as** — emerald callout: one paragraph of current truth + next action (usually “agree open blockers, then the story Plan step”).

Skip on the **first draft** before any tracker join; add as soon as keys exist (eyebrow key, journey story links, or decision tickets).

## Job frame (`#job`) — required

Cards or short lists:

- **Actors**
- **Success looks like**
- **Constraints** — platform, density, existing components, accessibility bar

## At a glance (`#locks`) — when any decision is locked

Two-column grid:

| Left (emerald border) | Right (sky border) |
|----------------------|-------------------|
| **Locked** — D1, D2, … one line each | **Handoff** — numbered: agree open blockers, then the story Plan step with journey expectations |

## Journeys (`#journeys`) — required

Priority-ordered journey cards (`id="j1"`, `j2`, …):

| Field | Rule |
|-------|------|
| **Name** | Short goal title (becomes test **name** seed) |
| **expectation** | `step > step > outcome` (becomes TDD **expectation**) |
| **Efficiency** | What was cut, merged, or defaulted |
| **Failure / recovery** | One primary path — not every edge |

Optional Mermaid flowchart for the happy path when more than ~4 steps. Prefer cards over walls of prose.

## Surfaces (`#surfaces`) — required

Table or compact cards:

| ID | Surface | Purpose | Primary action |
|----|---------|---------|----------------|
| S1 | … | … | … |

Prefer **one primary action** per surface. Flag screens that compete for two jobs (amber).

## States matrix (`#states`) — required

Per surface (or shared pattern): **empty · loading · error · success**. Short cells — one line each. Emerald tint for success definitions that are acceptance-ready.

## Decisions (`#decisions`)

- **Open** — fuller cards (options + Recommended); amber badge
- **Resolved** — compact emerald cards: title · `resolved · {choice}` · one why line
- IDs: `id="d1"`, `d2`, … for deep links

Do not append chat history. Update cards in place.

## Accessibility (`#a11y`)

Bullets: labels/roles for primary actions, keyboard path, contrast notes, “no information by color alone”. Prefer role and accessible name locators when tests will exist.

## Open questions (`#open`)

Table: Question · **Blocks** (story Plan step \| `defer`) · Notes. Amber for `blocks: plan`.

## Non-goals (`#nongoals`)

Short bullets — flows/screens out of scope.

## Handoff (`#handoff`) — required

Sky border card:

1. Next step: **the story Plan step**
2. Seed from journeys: each J* → Behavior & Test Contract (`name` + `expectation`)
3. Path to this plan's Markdown source of truth
4. Optional: path to the thin Markdown export if written

## Footer

One-liner: status + next action + plan path.

## Style

- Zinc dark background (`bg-zinc-950`), light text, **serif headings**, generous `space-y-14`
- Emerald = locked/success; sky = handoff/current; amber = open/blocked; violet sparingly for secondary journeys
- `text-xs uppercase tracking-wider` for section labels inside cards

## Tone

Plain English. Cards and tables carry the plan. If a sentence could be a bullet, make it a bullet. No hedging. No pixel polish specs unless required by constraints. Apply the `anti-slop` skill — expand abbreviations on first use; no brochure voice.
