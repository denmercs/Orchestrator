# Recording a feature evidence clip

Capture **one watchable journey** on the consumer’s existing browser end-to-end (E2E) tree. Do not add a second runner.

## Tags

Prefer Playwright tags:

- `@evidence` — story / human-check set (this skill)
- Do **not** reuse `@release` / `@demo` (those are Ship / the `release-distribution` skill's demo journeys)

```ts
test.describe('Evidence: save draft @evidence', () => {
  // …
});
```

If the consumer already uses another tag for the same job, document it on the card and use that.

## Enable video in the spec

Keep global `playwright.config` as CI wants it. Turn video **on for this spec only**:

```ts
import { test, expect } from '@playwright/test';

test.use({
  video: 'on',
  viewport: { width: 1280, height: 720 },
});

test('Feature: save draft @evidence', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');
  await page.waitForTimeout(800); // evidence-only last-frame settle
});
```

- **Video:** `on` (retain on success). CI spines may stay `retain-on-failure`.
- **Screenshot:** optional at each beat (`page.screenshot`) — list paths on the card.
- **Trace:** optional for debug; humans watch the video.
- **Workers:** 1 (`npx playwright test --workers=1 --grep @evidence`).
- **`waitForTimeout`:** only in `@evidence` specs, after the result is visible. Do not copy into CI spines.

Point at `e2e/`, `tests/e2e/`, or the path `AGENTS.md` names.

## Journey design

- One tagged spec (or describe) per **feature** / Behavior contract
- **Spine assertions only** — landed on the right screen, primary control worked, result visible
- Do **not** re-assert every validation branch already covered in unit tests
- Locators: role / label / text first; test ids last
- Prefer adding `@evidence` to an existing spine over duplicating the same clicks

## Pacing for humans

| Do | Don’t |
|----|--------|
| Open → act → show result | Race through clicks with no settle |
| Stable viewport (1280×720 unless the consumer documents another) | Random window sizes |
| Same persona/login for the clip | Switch accounts mid-feature without reason |
| App URL from consumer env / `AGENTS.md` | Invent production hosts |

## Run shape

```bash
npx playwright test --grep @evidence --workers=1
# or a consumer script, e.g. yarn e2e:evidence
```

If no evidence script exists, propose `e2e:evidence` that greps `@evidence` — do not invent product paths beyond what the repo already uses.

**Cypress-only repos:** use Cypress’s built-in video; same card + collect step. Do not add Playwright beside Cypress.

## Collect

After the run, copy the newest `.webm` / `.mp4` from `test-results/` (or `e2e/test-results`, `tests/e2e/test-results`):

```bash
node .claude/skills/feature-video-evidence/scripts/collect-video.cjs . --slug save-draft
```

Fallback: `~/.claude/skills/feature-video-evidence/scripts/collect-video.cjs`.

Prints the relative destination path (`.harness/evidence/<slug>.webm`). Exit 1 if no clip found.
