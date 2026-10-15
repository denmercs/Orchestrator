# Code handoff — living HTML

Self-contained HTML briefing for a **human code walkthrough**. This file is the **review brief** — open in a browser, survive sessions, understand the branch without the agent chat.

**Presentation:** **dark mode** (zinc-950 chrome, GitHub-like diff blocks). Sticky nav, emerald/sky/amber accents, Mermaid (`theme: "dark"`) when structure helps, sparse prose. Prefer scaffolding with `init-plan-html.cjs --kind handoff` (run from the `plan-html` skill, see SKILL.md).

**Lifecycle:** Prefer `init-plan-html.cjs --kind handoff` for chrome when the file is missing; rewrite **`.harness/code-handoff.html`** on every handoff run; validate with `validate-plan-html.cjs --kind handoff`. Do not timestamp a new file per run.

## Why HTML

| Format | Use |
|--------|-----|
| **`.harness/code-handoff.html`** | Human walkthrough — open in browser |
| `.harness/state.md` | Contracts / evidence source (do not duplicate whole state) |
| Chat / Canvas | Scratch only — never replace the HTML brief |

## Theme (required)

- Body: `bg-zinc-950 text-zinc-100` (dark). Do **not** use stone/light page chrome.
- Mermaid: `theme: "dark"`.
- Keep Tailwind CDN + Mermaid ESM only.

Keep the chrome and CSS the scaffold produces (it includes `.diff-file` styles). When rewriting content, **preserve** the `<style>` block and dark classes.

## Scaffold

Start from the scaffold (or keep its head/nav/CSS). Sections:

`#intent` · `#decisions` · `#map` · `#hotspots` · `#frontend` · `#backend` · `#tests` · `#verify` · `#out`

Surface sections are **always present**. Fill from the diff, or one line **N/A**.

## Sticky nav

Compact top bar (`text-xs`): issue/branch label + in-page anchors. Include Frontend / Backend. Emphasize **Verify** (`#verify`, `text-sky-400`). Keep scannable — no paragraphs.

## Header

- Eyebrow: `{{repo or plugin}} · {{issue key}}`
- `h1` serif: **Code handoff**
- Meta row: **Branch** · **Base** · **Updated** (ISO date)
- One strong sentence: what this slice delivers
- Next-step callout (sky border): open `#verify`, then open the pull request

## Surface detection (agent)

From `git diff --name-only` (product-neutral):

| Paths suggest | Fill |
|---------------|------|
| `*.tsx` / `*.jsx` / `*.vue` / app `src/` UI / CSS modules that own interaction | **`#frontend`** checklist below |
| `*.php` / `includes/` / REST / WP-CLI / cron / plugin bootstrap | **`#backend`** checklist below (WordPress flavor when stack is WP) |
| Both | Both sections |
| Neither | Both: one line each — `N/A — no UI` / `N/A — no PHP` |

## Sections (required unless N/A — one line why skipped)

### Intent (`#intent`)

One short paragraph from `state.md` / commits. Not a changelog dump.

### Decisions used (`#decisions`)

Bullets mapped to state (and ADR / arch-plan ids when referenced). Emerald text for locked. If none: one amber line.

### Change map (`#map`)

Mermaid (`flowchart` / `sequenceDiagram`) when modules or data flow help; otherwise a tight list of areas touched. Keep diagrams small.

```html
<pre class="mermaid">
flowchart LR
  A[Entry] --> B[Changed module]
</pre>
```

### Hotspots (`#hotspots`) — GitHub-style code changes

Usually 2–6 files. Each hotspot is a **diff file block**, not a plain `<pre class="code">`.

```html
<article>
  <p class="text-sm text-zinc-400">One-line why it matters</p>
  <div class="diff-file">
    <div class="diff-file__header">
      <span class="diff-file__badge">Code changes</span>
      <span>path/to/File.ext</span>
      <span class="diff-file__meta">+3 −1</span>
    </div>
    <div class="diff-file__body">
      <div class="diff-line diff-line--ctx">
        <span class="diff-line__num">10</span>
        <span class="diff-line__mark"> </span>
        <code class="diff-line__code">unchanged context</code>
      </div>
      <div class="diff-line diff-line--del">
        <span class="diff-line__num">11</span>
        <span class="diff-line__mark">-</span>
        <code class="diff-line__code">removed line</code>
      </div>
      <div class="diff-line diff-line--add">
        <span class="diff-line__num">11</span>
        <span class="diff-line__mark">+</span>
        <code class="diff-line__code">added line</code>
      </div>
    </div>
  </div>
</article>
```

Rules:

- Prefer real diff hunks (context + deletions + additions). Escape HTML in code.
- ≤20 lines per file block; otherwise summarize and point at the path.
- Line classes: `diff-line--add` (green), `diff-line--del` (red), `diff-line--ctx` (neutral).
- Badge text: **Code changes**. Meta: optional `+n −n` from the hunk.
- Never secrets, tokens, or full env files.

### Frontend (`#frontend`) — when UI is in the diff

Path-tied notes for a frontend reviewer (React web and/or React Native). Short bullets **plus Mermaid for state** (and effects only when they exist). **Do not** paste a React encyclopedia.

#### Platform (always when `#frontend` is filled)

One line so web and RN rules are not mixed:

```html
<p class="text-sm"><span class="text-zinc-500">Platform:</span> Web · Shared <!-- or: React Native · Shared --></p>
```

Use `Web`, `React Native`, and/or `Shared` for code used on both.

#### What to diagram (recommended order)

Prefer **state first**, not `useEffect` first. Effects are how we sync *after* state changes — they are not the story by themselves.

| Priority | Diagram | When |
|----------|---------|------|
| **1 — required if UI state changes** | **State transitions** (`stateDiagram-v2` or `flowchart`) | Any new/changed local state, reducer, store slice, URL/query state, derived UI mode |
| **2 — add when present** | **Effects / sync** (`flowchart`) | `useEffect` / `useLayoutEffect` / subscriptions / AbortController / timers / RN AppState listeners that react to those states |
| **3 — optional** | **Interaction** (`sequenceDiagram`) | Multi-step user path (open → edit → confirm) |
| **4 — when structure changed** | **Boundaries** (`flowchart`) | Provider → screen/route → list → row/modal mounts |

Skip all Mermaid only for pure markup/CSS with **no** state/effect/store churn — say so in one line.

#### State diagram (primary)

Show **modes** and **what flips them**. Label with real identifiers from the code (`previewStatus`, `selectedIds`, `isSaving`).

```html
<h3 class="text-sm uppercase tracking-wider text-zinc-500">State</h3>
<pre class="mermaid">
stateDiagram-v2
  [*] --> Idle: mount / selection empty
  Idle --> LoadingPreview: selectedIds set
  LoadingPreview --> Ready: setPreview
  LoadingPreview --> Error: setError
  Ready --> Saving: confirm
  Saving --> Ready: success
  Saving --> Error: fail
  Ready --> Idle: selection cleared
  Error --> Idle: selection cleared
</pre>
```

Also note in bullets: **who owns each state** (local vs store vs URL) and **what re-renders** when it changes.

#### Effects / sync diagram (when effects exist)

Only if the diff adds/changes effects or subscriptions. Tie each effect to the **state it reads** and the **state it writes** (or external I/O).

```html
<h3 class="text-sm uppercase tracking-wider text-zinc-500">Effects / sync</h3>
<pre class="mermaid">
flowchart TD
  Ids[selectedIds changes] --> Eff["useEffect([selectedIds])"]
  Eff -->|empty| Skip[no fetch]
  Eff -->|set| Fetch[GET preview]
  Fetch --> SetPreview[setPreview / setError]
  SetPreview --> ReRender[re-render]
  Eff -->|deps change / unmount| Abort[AbortController.abort]
</pre>
```

#### Boundaries (when tree / providers / screens changed)

Small mount map — catches “provider remount wiped state” and RN screen vs web mount differences.

```html
<h3 class="text-sm uppercase tracking-wider text-zinc-500">Boundaries</h3>
<pre class="mermaid">
flowchart TD
  Prov[ListStoreProvider] --> Screen[Posts screen]
  Screen --> List[Posts list]
  List --> Panel[BulkEditPanel]
  Panel --> Modal[Confirm modal]
</pre>
```

#### Risks / cons (recommended when state or effects exist)

Keep the state diagram **clean** (modes + events only). Put tradeoffs in a short **Risks / cons** list that **points at diagram nodes or transitions**.

Use amber text/border. Only real risks from *this* diff — no generic “React can re-render” filler.

| Risk type (examples) | Tie to |
|----------------------|--------|
| Extra re-renders / wide subscription | Which state or store select |
| Slow path / waterfall fetch | Which transition (e.g. `Idle → LoadingPreview`) |
| Stale close / missing abort | Which effect cleanup |
| Double-submit / race | Which state (`Saving`) |
| Layout thrash / focus loss | Mount/unmount or dialog open |
| List remount thrash | Unstable keys / `keyExtractor` / inline `renderItem` |
| RN JS-thread jank | Heavy work in render; non-worklet animation |
| RN keyboard / SafeArea jump | TextInput focus transition |
| RN AppState | Polling not paused on background |
| Gesture vs scroll fight | RN gesture handler vs `ScrollView` |

```html
<div class="border-l-4 border-amber-500 pl-3 text-sm space-y-1">
  <p class="text-xs uppercase tracking-wider text-amber-400">Risks / cons</p>
  <ul>
    <li><strong>LoadingPreview:</strong> preview fetch on every <code>selectedIds</code> change — rapid multi-select can spam requests (mitigated by AbortController).</li>
    <li><strong>Ready → Saving:</strong> no disable on Confirm yet — double-click can fire two batch saves.</li>
  </ul>
</div>
```

Optional: mark risky nodes in the **effects** flowchart with an amber label suffix `(risk)` — do **not** clutter the state diagram with cons text.

#### Checklist blocks

| Block | Cover |
|-------|--------|
| **Platform** | `Web` / `React Native` / `Shared` |
| **State (Mermaid)** | Modes + events; ownership; what re-renders |
| **Effects / sync (Mermaid)** | When effects/subscriptions exist — deps → I/O → setState → cleanup |
| **Boundaries (Mermaid)** | When provider/screen/list/modal tree changed |
| **Risks / cons** | Amber callout mapped to nodes — re-renders, slowness, races, RN jank (only if real) |
| **Lists & identity** | When lists change — keys / `keyExtractor`, stable IDs, virtualization (`FlatList`/`FlashList` vs web) |
| **Nav / focus lifecycle** | When routed or RN screens — `focus`/`blur` vs mount-only fetch; back-stack restore |
| **Concurrent / Suspense** | When used — `startTransition`, `useDeferredValue`, Suspense/lazy boundaries |
| **Forms / inputs** | Controlled value owner; disable while `Saving`; RN keyboard dismiss |
| **Error & empty** | Error boundary vs inline error; empty list — must match state diagram |
| **Interaction (optional Mermaid)** | User action → state update → UI result (+ failure) |
| **Render triggers** | Props, store select, context, parent — flag wide subscriptions |
| **Mount / unmount** | What mounts with which state; cleanup |
| **Timing** | Fetch on mount vs interaction vs screen focus; races; debounce |
| **A11y / RN a11y** | Focus on open/close; keyboard path; RN accessibilityLabel when touched |
| **Perf** | Only when real (hot list, expensive render, RN JS thread) |

#### Verify hints (feed `#verify`)

When `#frontend` is filled, pull concrete checks into `#verify`, for example:

- Fast double-click / double-tap on primary action  
- Change selection / deps mid-flight (abort / no stale setState)  
- Screen blur→focus or navigate away/back (RN or routed web)  
- Keyboard open/dismiss + SafeArea (RN)  
- Background → foreground if polling/AppState touched (RN)  
- List scroll + update (identity stable; no jump to top)  

If no UI paths: `<p>N/A — no UI in this diff.</p>`

### Backend (`#backend`) — when PHP / server is in the diff

Path-tied notes for a backend / WordPress reviewer. Product-neutral name; use WP vocabulary when the stack is WordPress.

| Block | Cover |
|-------|--------|
| **Request / hook flow** | Hook or REST → classes → response/side effect (Mermaid when helpful) |
| **Capabilities & authz** | Who can hit it; `permission_callback` / `current_user_can` |
| **Data writes** | Options, post meta, custom tables — sanitize / validate / escape touchpoints |
| **Queries** | New SQL / `WP_Query`; N+1; cache (`wp_cache_*`, transients) when relevant |
| **Lifecycle** | Activation, cron, shutdown, uninstall register/unregister |
| **REST / WP-CLI** | Routes, args schema, idempotency |
| **Multisite / roles** | Only when the change cares |

If no PHP/server paths: `<p>N/A — no PHP in this diff.</p>`

### Tests and evidence (`#tests`)

Table: Behavior / contract → test path or TDD Evidence row. Note Verification Plan commands from state.

### What to verify — human (`#verify`)

Checklist of concrete checks. Pull FE and backend checks from `#frontend` / `#backend` (UI path, REST 403 as subscriber, double-submit, etc.). Not “looks good.” Sky border callout: **Do this before opening the pull request**.

### Out of scope / follow-ups (`#out`)

Only items already parked in state or clearly not in the diff.

## Colour

- Page: zinc dark chrome  
- Emerald = locked / done / evidence PASS  
- Sky = current / verify / next  
- Amber = missing state / open risk  
- Diff green / red = add / delete lines (GitHub-like)

## Footer

One line: path to this file · path to `state.md` · next step (open the pull request after the security check passes).

## Anti-slop

Apply the `anti-slop` skill to narrative. Expand abbreviations on first use. Cite paths instead of restating whole files.
