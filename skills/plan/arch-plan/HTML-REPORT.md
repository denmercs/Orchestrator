# Architecture plan — living plan (MD → HTML)

Self-contained briefing for **project/plugin direction**. **Markdown is the plan source of truth**; HTML is derived for the browser with the render script (`.claude/skills/plan-html/scripts/render-plan-html.cjs`, fallback `~/.claude/skills/plan-html/scripts/render-plan-html.cjs`). Prefer this over chat dumps; the plan must survive sessions and accept a Jira to Markdown refresh.

**Presentation reference:** sticky nav (highlight **Start → finish**), Phase, ordered **finish-line** story path, dual-track Epic A/B when needed, At a glance, Current|Target side by side, compact decisions, stages, optional sizing + epic portfolio. **Dark mode** zinc chrome + emerald/sky/violet accents (render chrome); Mermaid `theme: "dark"`; sparse prose.

**Lifecycle:** rewrite the **same `.md`** after every material follow-up and after every Jira status refresh, then re-render HTML. Do not timestamp a new file per answer. Rejected explorations may live in a sibling archive MD linked from the plan — do not clutter the source of truth with discarded forks.

## Why Markdown + derived HTML

| Format | Use |
|--------|-----|
| **`architecture-plan.md`** (pack under `.harness/initiatives/<slug>/`) | **plan source of truth** — decisions, Mermaid, stages, keys, refreshed status |
| **`architecture-plan.html`** | Human browser view — **derived** with the render script; do not hand-edit |
| Markdown ADRs / `CONTEXT.md` | Narrow permanence for *why* / glossary |

## Scaffold

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Architecture plan — {{product or plugin name}}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script type="module">
      import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
      mermaid.initialize({ startOnLoad: true, theme: "dark", securityLevel: "loose" });
    </script>
    <style>
      .deep { background: linear-gradient(135deg, #09090b, #18181b); }
      html { scroll-behavior: smooth; }
      section[id] { scroll-margin-top: 5rem; }
      a { color: #93c5fd; }
    </style>
  </head>
  <body class="bg-zinc-950 text-zinc-100 font-sans">
    <nav class="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur px-4 py-2">
      <!-- Phase · Start → finish · Epic B? · Locks · Current · Target · … · Stages · Epic portfolio -->
    </nav>
    <main class="max-w-5xl mx-auto px-6 py-10 space-y-14">
      <header>…</header>
      <section id="phase">…</section>
      <section id="finish-line">…</section>  <!-- required once stories are keyed -->
      <section id="locks">…</section>
      <section><!-- Current | Target grid --></section>
      <section id="decisions">…</section>
      <section id="stages">…</section>
      <section id="sizing">…</section>      <!-- optional -->
      <section id="nongoals">…</section>
      <section id="epic-portfolio">…</section> <!-- optional; when tracker has many epics -->
      <footer>…</footer>
    </main>
  </body>
</html>
```

Only scripts: Tailwind CDN + Mermaid ESM. Otherwise static.

## Sticky nav

Compact top bar (`text-xs`): product label + in-page anchors. Emphasize **Start → finish** (`#finish-line`) when that section exists (e.g. `font-medium text-sky-900`). Link secondary epic tables (`#epic-b`) when present. Include archive link only if an archive file exists. Keep nav scannable — no paragraphs.

## Header

- Eyebrow: `{{repo or plugin}} · {{Jira project key}}`
- `h1` serif: **Architecture plan**
- Meta row: **Status** (e.g. `draft` | `decisions locked` · stages mirrored…), **Updated**, **Last Jira refreshed** (note what was refreshed, e.g. finish-line / Epic B table)
- **Primary job** — one strong sentence (what this architecture delivers)
- Source-of-truth one-liner: epic keys join Jira; status refreshed on refresh
- Legend chips: module · seam · leakage · deep

## Phase we are at (`#phase`) — required once tracking exists

Two clocks so the reader knows where they are:

1. **Delivery loop (this plan)** — ordered list: roadmap, architecture plan, split into stories, next story Plan slice. Grey completed steps; bold the current one (sky border card).
2. **Jira posture** — which epics are the homes for this plan (white card); point to `#finish-line` for the ordered story path.
3. **Mapping table** — arch lock/stage → Jira home → status (one row per join).
4. **Read this as** — emerald callout: one paragraph of the current truth + next action.

Skip a full phase section only on the **first draft** before any tracker join; add it as soon as keys exist.

## Start → finish line (`#finish-line`) — required once stories are keyed

The **ordered delivery path** humans follow — not a second source of truth, a reading of the plan as a sequence. Refresh story statuses here on refresh.

1. **▶ Start here (now)** — sky border card: current coding story key, status badge, epic home, what it blocks, next step after close.
2. **Spine table** — columns: `#` · Story · Epic · Role · Jira · Depends on  
   - Highlight the current row (`bg-sky-50`).  
   - End with a **🏁 finish row**: arch finish (platform stages + secondary track) and optional product/beta gate epic.
3. **Epic A | Epic B cards** (when two homes) — two-column summary: platform home vs secondary track (violet border for B).
4. **Secondary epic story table** (`#epic-b` or `#epic-{{letter}}`) — full ordered stories under the secondary epic (violet). Include Done/historical rows greyed, **skip/pointer** rows for merged issues, **🏁B** finish row.
5. **Recommended pickup rule** — short numbered list (what to close next, when to interleave tracks) + optional JQL snippets.

**Dual-track rule:** Epic A = stage/platform spine (S0–S5). Epic B = secondary capability train that interleaves with A. Do not invent parallel stage epics for B — B is its own epic’s stories. More than two tracks is rare; prefer portfolio park over Epic C/D/E sprawl.

Colour: sky = start/current; violet = secondary epic track; emerald = done / finish line; amber = blocked.

## At a glance (`#locks`) — required when any decision is locked

Two-column grid:

| Left (emerald border) | Right (sky border) |
|----------------------|-------------------|
| **Locked** — bullet list of D0, D1, … one line each | **Handoff** — numbered next steps (align with finish-line “start here”) |

Optional `<details>` **Glossary + FAQ** under the grid — terms that stop re-asking the same question.

## Current | Target — required

**Side-by-side** on `md+` (`grid md:grid-cols-2`), not stacked full-page sections only:

- **Current** (`#current`) — Mermaid of today’s modules/leakage; optional second diagram (pipeline)
- **Target** (`#target`) — Mermaid of desired shape; emerald border; optional “gold path” flowchart + ≤5 bullets

Keep diagrams ~comfortable height; prose under each column ≤2 short lines.

### Optional critical-path section

If one flow carries the architecture (for example UI input, then a service, then storage), add a dedicated section with Mermaid + `<details>` for file/hook touch points. Omit when Current|Target already says enough.

## Decisions (`#decisions`)

- **Open** — fuller cards (options + Recommended) while undecided; amber badge
- **Resolved** — compact emerald cards: title · `resolved · {choice}` badge · one short why line
- IDs: `id="d0"`, `d1`, … for deep links from Phase / Stages
- When none open: one line — “No open architecture decisions. See handoff.”

Do not append chat history. Update cards in place.

## Stages (`#stages`)

Intro line: stage **home epic**(s) + any lean/secondary epic. Then compact stage cards:

| Field | Rule |
|-------|------|
| **ID** | `S0`… — `id="stage-S2"` |
| **Title** | verb + module |
| **Acceptance** | one line |
| **`data-epic`** | stage home epic (often **shared** across S0–S5) |
| **`data-story`** | optional implement story under that epic |
| **Visible key** | link the story when present, else the epic |
| **Jira status** | raw status / blocked-by — refreshed on refresh only |

Prefer **folding stages into existing epics** + stories over creating one new epic per stage. One epic per stage is fine when no home epic exists.

```html
<article id="stage-S1" data-epic="PROJ-245" data-story="PROJ-271"
  class="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
  <div class="flex flex-wrap items-center gap-2">
    <span class="font-mono">S1</span>
    <strong>Define billing interface</strong>
    <a class="rounded bg-slate-100 px-2 py-0.5 text-xs font-mono underline" href="…">PROJ-271</a>
    <span class="rounded bg-slate-100 px-2 py-0.5 text-xs uppercase">To Do</span>
  </div>
  <p class="mt-1 text-slate-600">Acceptance: …</p>
</article>
```

Done/home stages may use emerald tint. Never drive Jira transitions from the HTML.

## Work sizing (`#sizing`) — optional

Small table: slice · effort band · notes. Confidence caveat. Tighten in the story Plan step — do not pretend precision.

## Non-goals (`#nongoals`)

Short bullets + optional “Inputs: ADR … · CONTEXT …”.

## Epic portfolio (`#epic-portfolio`) — optional

When the project has many epics, map them against **this** locked plan:

- **Active now** (v1 spine) — emerald
- **Close / collapse / park** — amber (label + park preferred over delete)
- **Already deferred** — icebox / archive
- **Keep later** — no arch conflict

One-way read for humans; refresh statuses on each plan refresh. Do not create parallel stage epics that fight the portfolio.

## Footer

Handoff one-liner with next issue keys + path to the source of truth (+ archive link if any).

## Style

- Zinc dark background (`bg-zinc-950`), light text, **serif headings**, generous `space-y-14`
- Emerald = locked/done/target/finish; sky = current phase/start-here/handoff; **violet = secondary epic track (Epic B)**; amber = open/blocked/park; red = leakage only
- `text-xs uppercase tracking-wider` for section labels inside cards
- Use the glossary terms (module, interface, seam, depth) for module/seam/depth language

## Tone

Plain English. Diagrams carry structure; cards carry decisions; **finish-line** carries pickup order. If a sentence could be a bullet, make it a bullet. No hedging. Apply the `anti-slop` skill — expand abbreviations on first use; no hype in “At a glance”.
