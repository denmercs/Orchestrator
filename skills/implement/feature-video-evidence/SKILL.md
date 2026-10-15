---
name: feature-video-evidence
description: >
  Records a paced Playwright (or the consumer’s existing browser end-to-end)
  journey of one feature with video on, then writes a human watch card and the
  clip path. Use when the user wants video evidence a feature works, a human
  check of the running UI, feature-video-evidence, or a Playwright
  walkthrough recording for assessment. Not launch reels
  (release-distribution) or code walkthroughs (code-handoff).
---

# Feature video evidence

Produce a **watchable clip** of one feature so a human can judge it — not a CI dump, not a launch reel.

**Does:** Drive the consumer’s existing browser end-to-end (E2E) runner (Playwright first), keep video on success, copy the clip, write a watch checklist.  
**Does not:** Replace review or security gates, unit/TDD spines, or Ship demo tags (`@release` / `@demo`).

Use when the change has a user-visible surface and a human needs a clip. Skip when there is no UI or no browser E2E.

## When to use / skip

| Use this | Skip / use something else |
|----------|---------------------------|
| Human needs to see the feature run | Backend-only / no UI → stay on tests + `code-handoff` |
| One story / one journey | Launch reel / What’s new → the `release-distribution` skill |
| Playwright (or Cypress) already in the repo | No browser E2E → stop; say what is missing. Do not invent a second framework |

## Workflow

1. **Name the feature** — from the user, or the plan's behavior contracts (one journey).
2. **Find the runner** — `playwright.config.*`, `e2e/`, `tests/e2e/`, or `AGENTS.md` scripts (`e2e`, `test:e2e`). Cypress only if that is what the repo already runs.
3. **Spec** — follow [RECORDING.md](RECORDING.md). Prefer tagging an existing spine `@evidence`. Else add one thin evidence spec. Locators: role, label or text first (`getByRole`, `getByLabel`, `getByText`); test ids last.
4. **Run** — workers 1; video on in the evidence spec (`test.use({ video: 'on' })`). App URL from consumer docs / env — do not guess production.
5. **Collect** — copy the newest clip into `.harness/evidence/`:

   ```bash
   node .claude/skills/feature-video-evidence/scripts/collect-video.cjs . --slug <kebab-feature>
   ```

   Fallback when the skill is installed globally: `~/.claude/skills/feature-video-evidence/scripts/collect-video.cjs`.
6. **Card** — write `.harness/feature-evidence.md` from [CARD.md](CARD.md).
7. **Tell the human** — card path + video path. They watch and tick **Human verdict**. Do not mark the human box yourself.

**Spine FAIL:** still collect the clip if one exists (failure is evidence). Fix the product or the journey; do not weaken assertions to force a pretty video.

## Output

| Path | Role |
|------|------|
| `.harness/feature-evidence.md` | Watch card (source of truth for the human) |
| `.harness/evidence/<slug>.webm` (or `.mp4`) | Clip — keep out of git |

## Related

| Skill | Relationship |
|-------|--------------|
| `code-handoff` | Code walkthrough — complementary; this is the running UI |
| `release-distribution` | Ship / marketing clips (`@release`) — not story assessment |

Video does not replace code review.
