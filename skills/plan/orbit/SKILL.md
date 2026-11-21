---
name: orbit
description: Run an initiative through the Orchestrator story loop from the command line. Creates an initiative, plans a phase with the architect, starts or stops the loop, and shows what waits on you. Use when the user types /orbit, or asks to create an initiative, plan a phase, start or stop the initiative loop, or see where an initiative stands.
---

# Orbit

`/orbit` drives the Orchestrator story loop (Plan → Implement → Review → PR) from the command line. `new` and `plan` do what the Initiatives tab's New initiative and New phase do. `start` and `stop` turn the story loop itself on and off. The tab's Start button is different: it files the stories for the factory manager.

Run the script (any agent can: Claude, Kiro, Codex and others all have the kit at these paths once it is linked):

```bash
node .claude/skills/orbit/scripts/orbit.mjs <command> [args]
```

If that path is missing, use `node ~/.claude/skills/orbit/scripts/orbit.mjs`.

## Commands

| Command | Does |
|---|---|
| `new <slug> "<outcome>" [--title "<title>"]` | Creates `.harness/initiatives/<slug>/initiative.md`, tracked locally, loop off |
| `plan <slug> "<phase>" [--title "<title>"]` | Creates the next phase and starts its architecture session. Creates the initiative too when it's new |
| `start <slug>` | Turns the loop on and starts every ready story of the active phase |
| `stop <slug>` | Turns the loop off. Running steps finish, and nothing new starts |
| `status [slug]` | Phases, stories and their status, then what waits on you |

Every command takes `--repo <path>`. Without it, the repo is the main checkout of the current folder, even from a story's worktree, because initiatives live in the main checkout. `plan`, `start` and `stop` wait up to 30 seconds for the plugin, and `--wait <seconds>` changes that.

## Usual run

1. `new debrief "Every story stops at a Debrief page before its PR" --title "Debrief"`
2. `plan debrief "Debrief v1"`. Answer the architect's questions one at a time in its session, then say **"lock"**.
3. `start debrief`.
4. `status debrief` whenever you want to see where it stands. What waits on you is a plan to approve, a PR to merge, or a blocked story with its reason.

## How it reaches the plugin

`new` and `status` only read and write the repo's `.harness/` files. `plan`, `start` and `stop` write one request to `~/.orchestrator/orbit.json`. The Orchestrator plugin picks it up within about 5 seconds, removes it, and writes `~/.orchestrator/orbit.result.json`. The script prints that result and removes it.

- **No answer** means Paseo isn't running or the plugin isn't loaded. The script removes its request so it can't run later by surprise.
- **"Another orbit request is still waiting"** means an earlier request was never picked up. Check the plugin, then delete the file.

## Rules

- Say what the script printed. Don't report a phase planned or a loop started unless the result says `ok`.
- Never edit story frontmatter to move a story along. The loop owns it.
- Stories wait on the person steering at three gates: plan approval, merge and blocked. `/orbit` never approves or merges for them.
