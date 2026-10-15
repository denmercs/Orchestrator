---
name: bugfix
description: >-
  Cursor Debug Mode loop in Agent: hypothesize, POST probes into a local
  debug log (.harness/debug-<tag>.log), reproduce (agent runs the app when
  it can), inspect that log, propose a small fix. Use when the user says bugfix,
  "debug mode", "instrument and run", or wants logs on affected
  files before a fix. Not for Story TDD implement (use tdd). Hard/perf loops
  with no runtime path: use diagnose.
---

# Bugfix

Same loop as [Cursor Debug Mode](https://cursor.com/docs/agent/debug-mode): hypotheses → logs on likely files → runtime evidence → small patch. **Do not guess-and-rewrite.**

If the user is already in Cursor **Debug Mode**, follow that mode (extension ingest + they reproduce). Do not mix this skill into that session — mode switch is a fresh context.

In **Agent**: **do every step you can yourself.** Start the ingest (`node .claude/skills/bugfix/scripts/bugfix-debug-log.cjs start --tag <tag>`, fallback `~/.claude/skills/bugfix/scripts/bugfix-debug-log.cjs`), POST probes into `.harness/debug-<tag>.log`, then read that file. Do not ask them to reproduce if you can drive the app, tests, browser, CLI, or simulator.

## Loop

1. **Symptom** — Expected vs actual. Capture error, stack, and repro hints from the user message. Do not stall for a perfect write-up.
2. **Hypotheses** — 3–5 falsifiable guesses, ranked. Each: `If X, then log/probe Y will show Z.` Do not wait for ranking approval.
3. **Instrument** — Start the debug-log ingest, then add POST probes on the files that distinguish those guesses. See [instrument.md](instrument.md).
4. **Reproduce** — Run it. Order: failing test → script/CLI → `yarn`/`npm`/`wp-cli` → browser tools → device/emulator.
5. **Read evidence** — Open `.harness/debug-<tag>.log`. Confirm or kill each hypothesis. Empty file after a real repro means wrong seam, not “disproved.” Max two instrument rounds.
6. **Propose** — Root cause in one or two lines + the smallest patch that matches the evidence. **Stop. Do not apply the product fix yet.**
7. **Apply gate (human)** — Ask: apply, skip, or keep investigating. After **apply**: patch, re-run the same repro, stop the ingest, strip probes, delete the log.

Cursor’s documented human step is **reproduce**, then it patches, then you verify and it strips logs. This skill still agent-runs the repro when it can, and adds an **apply gate** before the product patch.

## Ping the human only when

- Repro needs a real device, logged-in session, or environment you cannot reach
- Apply/skip/keep-investigating (step 7)
- The bug is gone after the patch but you cannot tell if the product *feels* right (gray-area UX)

Do **not** ping to confirm hypotheses, log placement, which test file to run, or cleanup.

## Fix rules

- Patch the proven cause. A few lines, not a rewrite.
- Leave a regression check at a real seam when one exists (`tdd`). If none, say so — do not invent a shallow test.
- Never commit probes or `.harness/debug-*.log`. Grep `127.0.0.1:7399` and the tag before done.

## Vs diagnose

| This skill | the `diagnose` skill |
|------------|-------------------------------------|
| Reproducible app/UI/API bug; logs + run | No loop yet, flaky/perf, need a constructed harness |

If you cannot get a runtime signal after two instrument rounds, switch to diagnose or stop and name the gap.
