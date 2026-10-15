---
name: code-handoff
description: >
  Write a human-facing walkthrough of branch code changes from .harness/state.md
  and git diff. Markdown is the source of truth; HTML is derived with the
  plan-html render script (intent, decisions, Mermaid maps, snippets, verify
  checklist). Use for a human walkthrough of the branch. Not a journal entry,
  a critic PASS/FAIL, or opening a pull request.
---

# Code handoff (human walkthrough)

Produce durable **Markdown** plus derived **browser HTML** so a person can review the change set without the implement and review chat.

**Does:** Explain *what changed and why* using **`.harness/state.md`** and **`git diff`**, written as **`.harness/code-handoff.md`**, then render it with `render-plan-html.cjs --kind handoff`.
**Does not:** Replace review or security gates, open a pull request, merge, or close the ticket.
**Not the same as:** a weekly journal entry. Loop handoff is the markers in `.harness/state.md`.

**Presentation:** follow [HTML-REPORT.md](HTML-REPORT.md) for sections. Humans open the **derived HTML**; agents edit **Markdown only**.

## Companion extra

Load `plan-html` with this skill; it holds the render scripts.

Run them as `.claude/skills/plan-html/scripts/<file>`. If that path is missing, use `~/.claude/skills/plan-html/scripts/<file>`.

- Scaffold: `node .claude/skills/plan-html/scripts/init-plan-html.cjs . --kind handoff --task "<issue or title>"` (fallback `~/.claude/skills/plan-html/scripts/init-plan-html.cjs`)
- Render: `node .claude/skills/plan-html/scripts/render-plan-html.cjs . --kind handoff --validate` (fallback `~/.claude/skills/plan-html/scripts/render-plan-html.cjs`)
- Validate: `node .claude/skills/plan-html/scripts/validate-plan-html.cjs . --kind handoff` (fallback `~/.claude/skills/plan-html/scripts/validate-plan-html.cjs`)

## Principles

- **State is the contract.** Ground the story in the behavior and test contracts, the red-to-green test evidence, locked decisions, and security evidence when present. Do not invent architecture that is not in state or the diff.
- **Diff is the evidence.** Every claim about behavior should point at a path or a short snippet from the change set.
- **Surface notes.** Fill frontend and backend from changed paths (UI versus server code); otherwise one-line N/A.
- **Human first.** Open-in-browser HTML; scannable sections; Mermaid when structure helps.
- **Offload context.** The brief must stand alone in a fresh session (open the HTML plus the pull request or diff).
- **Prose.** Apply the `anti-slop` skill: expand abbreviations on first use; no hype; cite paths instead of restating whole files.

## Inputs

1. **`.harness/state.md`** (optional context): task title, decisions, contracts, verification plan, critic and security verdicts when present.
2. **Base...HEAD diff.** Default base is the repo default branch (`main` or `master`). Ask if unclear.
3. **Optional:** living plan Markdown under `.harness/` (architecture, UX, security). Link and quote decision ids; do not dump whole files.

If `state.md` is missing or empty, still write a diff-based walkthrough and note that harness context was absent.

## Steps (agent)

1. Read **`.harness/state.md`** (full file if present) and [HTML-REPORT.md](HTML-REPORT.md).
2. If **`.harness/code-handoff.md`** is missing, scaffold it:

   ```bash
   node .claude/skills/plan-html/scripts/init-plan-html.cjs . --kind handoff --task "<issue or title>"
   ```

   Use `--force` only to reset the scaffold (destroys prior content).
3. Resolve the base branch; collect:
   - `git log --oneline <base>..HEAD`
   - `git diff --stat <base>...HEAD`
   - `git diff --name-only <base>...HEAD` to decide frontend and backend fill versus N/A
   - Targeted `git diff <base>...HEAD -- <path>` for hotspots (not the entire dump in the brief).
4. Rewrite **`.harness/code-handoff.md`** (same path every time). Always include frontend and backend (filled or N/A). Use ` ```html ` fences for `.diff-file` blocks when needed.
5. Render and validate:

   ```bash
   node .claude/skills/plan-html/scripts/render-plan-html.cjs . --kind handoff --validate
   node .claude/skills/plan-html/scripts/validate-plan-html.cjs . --kind handoff
   ```

   Fix the Markdown until exit 0.
6. Print the **`.html`** path and tell the human to **open it in a browser**. Suggest next: complete `#verify`, then open the pull request (or run the security audit if it is not done).

In **Ask** mode: print the outline and commands; do not write the file unless the human asks.

## Output: `.harness/code-handoff.md` to `.html`

Required sections in the Markdown: **intent**, **decisions**, **map**, **hotspots**, **tests**, **verify**, **out**.
Expected: **frontend**, **backend**. Details: [HTML-REPORT.md](HTML-REPORT.md).

### Mermaid

Use when it clarifies structure. For **`#frontend`**: **Platform** line first; **state transition** Mermaid when UI state or store changes; **effects and sync** when effects exist; **boundaries** when the provider, screen or list tree changed; optional interaction sequence; amber **Risks / cons** mapped to nodes (re-renders, list thrash, React Native jank, races). Feed concrete frontend checks into `#verify` (double-tap, blur and focus, keyboard, list scroll). See [HTML-REPORT.md](HTML-REPORT.md).

### Snippets

- Prefer **added or changed** lines in GitHub-style `.diff-file` blocks (`diff-line--add`, `--del`, `--ctx`). See [HTML-REPORT.md](HTML-REPORT.md).
- Escape HTML in `<code class="diff-line__code">` cells.
- Never paste secrets, tokens, or full env files.
- Prefer path plus line range references when the file is large.
- Keep **dark mode** chrome from the scaffold (`bg-zinc-950`, Mermaid `theme: "dark"`).

## Finish line

- [ ] `.harness/code-handoff.html` rewritten; opens in a browser without chat history
- [ ] `validate-plan-html.cjs --kind handoff` exits 0
- [ ] Intent and decisions tied to `state.md` (or an explicit "no state")
- [ ] Hotspots cite real paths from the diff
- [ ] `#frontend` and `#backend` filled or explicit N/A from the diff surface
- [ ] `#frontend` has Platform; **state** Mermaid when state changes; **effects** when present; **Risks / cons** when tradeoffs are real; boundaries, lists and nav-focus when those changed; frontend checks mirrored in `#verify`
- [ ] `#verify` checklist is actionable (includes frontend and backend checks when those sections are filled)
- [ ] Next step named: usually open a pull request, not merge or close

## Related

| Skill | Relationship |
|-------|--------------|
| `feature-video-evidence` | Running-UI clip and watch card. Complementary; this skill is the diff |
| `submit-github-pr` | May reuse **Intent** from the HTML when drafting the pull request body |
| `jira-close-story` | Closes the ticket after merge |
